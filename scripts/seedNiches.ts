import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { Capabilities, ExtraFieldDef } from '../src/types'
import * as fs from 'fs'
import * as path from 'path'

const serviceAccountPath = path.resolve(__dirname, '../service-account.json')
const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'))

initializeApp({ credential: cert(serviceAccount) })

const db = getFirestore()

// ─────────────────────────────────────────────────────────────────────────────
// Niche-prompts
//
// Hver prompt bruger {{transcription}} som placeholder — den erstattes med
// brugerens transskription i runtime af /ai/analyze-handleren.
//
// generel = type-klassifikations-prompt (moede/opgave/beslutning/ide/note).
// NB: /ai/analyze bruger pt. den hardcodede analyzePrompt() i ai.ts for
// generel-flowet, ikke denne Firestore-version. Behold for /ai/vision-flowet
// og som dokumentations-fallback.
//
// haandvaerker (rebranded fra "vvs" 20. maj 2026) = fag-neutral prompt for
// VVS, elektrikere, murere, tømrere, tagdækkere, malere osv. Strukturen er
// identisk på tværs af fag; modellen bruger transskriptionens kontekst til
// at vælge fag-specifikt vokabular.
//
// vvs (LEGACY, isActive: false) = bevaret som arkiv. Refereres ikke længere
// af aktive klient-flows. Slettes ikke for at undgå at bryde ældre Android-
// versioner der har "vvs" liggende i lokal cache.
// ─────────────────────────────────────────────────────────────────────────────

const generelPrompt = `Du er en produktivitetsassistent. Analyser denne transskription og returner JSON med:
1. En kort sigende titel (max 6 ord)
2. Et kort resume (2-3 sætninger)
3. En liste af konkrete opgaver/handlinger — vær UDTØMMENDE: ekstraher ALLE handlinger der nævnes, både eksplicitte og implicitte. Det er bedre at have én opgave for meget end at glemme én.

Hvad tæller som en opgave:
- Direkte instruktioner ("ring til X", "bestil Y", "send mail til Z")
- Implicitte handlinger ("vi mangler at høre fra X" → "Følg op med X")
- Aftaler ("Jens skulle sende dokumenter" → "Modtag dokumenter fra Jens")
- Egne handlinger ("jeg skal...", "jeg vil...", "jeg må huske at...")
- Forberedelser og opfølgning
- Næste skridt nævnt eksplicit
Hvad tæller IKKE: ting allerede udført, generelle observationer uden handling, hypotetiske scenarier uden commitment.

Returner KUN dette JSON format:
{
    "title": "...",
    "summary": "...",
    "tasks": ["opgave 1", "opgave 2"]
}
Transskription: {{transcription}}`

const haandvaerkerPrompt = `Du er en assistent for håndværkere og fagfolk i Danmark — VVS-installatører, elektrikere, murere, tømrere, tagdækkere, malere, snedkere og lignende service-fag.

Brugeren har dikteret en talenotat fra et kundebesøg. Genkend brugerens fag ud fra konteksten (terminologi, materialer, opgavetype) og brug passende fag-specifikt vokabular i din strukturering.

Strukturér notatet i følgende JSON-format — udfyld KUN felter der er nævnt i transskriptionen, sæt resten til null eller []:

{
  "type": "haandvaerker_visit",
  "title": "Kort beskrivelse af besøget (max 8 ord, inkludér gerne kundenavn/adresse)",
  "kunde": "Kundens navn og/eller adresse hvis nævnt, ellers null",
  "transporttid_timer": 0.5,
  "udfoert_arbejde": [
    { "beskrivelse": "Hvad blev lavet (fag-specifik formulering)", "tid_timer": null }
  ],
  "materialer_brugt": [
    { "vare": "Varebetegnelse", "antal": null, "enhed": "stk/meter/liter/m²/kg/etc" }
  ],
  "observationer": ["Liste af ting set men ikke udbedret"],
  "bestillinger": ["Ting der skal købes/bestilles"],
  "naeste_besoeg": "Hvad skal laves ved næste besøg, ellers null",
  "faktureringsgrundlag": "tid + arbejde + materialer (fag-specifik formulering, ALTID i timer)",
  "tasks": ["Andre handlinger der ikke passer i ovenstående kategorier"]
}

Regler:
- Skriv på dansk med fag-specifikt vokabular
- "udfoert_arbejde" = kun det der faktisk ER lavet i dag
- "observationer" = ting der blev SET men IKKE udbedret i dag. Tjek: hvis noget allerede optræder i "udfoert_arbejde", må det IKKE gentages i "observationer". Kun nye fund der kræver fremtidig handling.
- "bestillinger" = varer/materialer der mangler og skal købes
- "faktureringsgrundlag" skal ALTID udfyldes med tid (hvis nævnt) + arbejde + materialer

TIDSANGIVELSER — VIGTIGT:
- ALLE tidsfelter er i TIMER som decimaltal (Double), ALDRIG i minutter.
- Tænk som en håndværker tænker faktureringsenheder — afrund til kvarter:
  · 15 min = 0.25 timer
  · 30 min = 0.5 timer
  · 45 min = 0.75 timer
  · 1 time = 1.0 timer
  · 1 time 30 min = 1.5 timer
  · 2 timer 15 min = 2.25 timer
- "tid_timer" i hvert udfoert_arbejde-element = faktisk arbejdstid på den opgave (Double, timer).
- Hvis tid ikke nævnes for en opgave: sæt "tid_timer": null.

TRANSPORTTID — top-level felt "transporttid_timer" (Double, timer):
- Registreres når talen nævner transport, kørsel, vej til/fra kunde, tankning undervejs eller lignende.
- Hvis transport nævnes som "X tid hver vej", beregn samlet tid som tur + retur (× 2), og afrund derefter til nærmeste kvarter (0.25 trin).
  Eksempel: "20 minutter hver vej" → 40 min total → afrundet til "transporttid_timer": 0.75
  Eksempel: "1 time hver vej" → 2 timer total → "transporttid_timer": 2.0
  Eksempel: "15 minutter hver vej" → 30 min total → "transporttid_timer": 0.5
- Hvis transport IKKE nævnes i transskriptionen: UDELAD feltet HELT fra JSON (skriv ikke null, skriv ikke 0).

GENERELT:
- Inkludér KUN hvad der eksplicit er nævnt i transskriptionen. Opfind aldrig tid, materialer eller andet der ikke fremgår direkte.
- Returner KUN valid JSON — ingen forklaring udenfor JSON

Eksempler på fag-specifik formulering (bemærk tid_timer + faktureringsgrundlag i timer):
- VVS: udfoert_arbejde { "beskrivelse": "Skiftet pakning 22mm i køkkenvask", "tid_timer": 0.25 } · materialer "2 stk. pakning 22mm" · faktureringsgrundlag "0.25 timer: Pakning skiftet i køkkenvask. Materialer: 2 stk. pakning 22mm"
- Elektriker: udfoert_arbejde { "beskrivelse": "Skiftet HPFI-relæ i hovedtavle", "tid_timer": 0.75 } · materialer "1 stk. HPFI 30mA 4-pol" · faktureringsgrundlag "0.75 timer: HPFI-relæ skiftet. Materialer: 1 stk. HPFI 30mA 4-pol"
- Murer: udfoert_arbejde { "beskrivelse": "Repareret 3m² puds på sydfacade", "tid_timer": 4.0 } · materialer "50 kg mørtel, 0.5 m³ sand" · faktureringsgrundlag "4.0 timer: Pudsreparation 3m². Materialer: 50kg mørtel + 0.5m³ sand"
- Tømrer: udfoert_arbejde { "beskrivelse": "Skiftet 4 brædder på terrasse", "tid_timer": 2.0 } · materialer "4 stk. terrassebræt 28x120mm" · faktureringsgrundlag "2.0 timer: Terrasse-brædder skiftet. Materialer: 4 stk. terrassebræt 28x120mm"

Eksempel med transport — transskription: "Jeg kørte ud til Hansen på Birkevej, 15 minutter hver vej. Skiftede en termostat på radiatoren, tog en halv time, brugte en ny termostat."
Output (uddrag):
  "transporttid_timer": 0.5,
  "udfoert_arbejde": [{ "beskrivelse": "Skiftet termostat på radiator", "tid_timer": 0.5 }],
  "materialer_brugt": [{ "vare": "Termostat", "antal": 1, "enhed": "stk" }]

Eksempel UDEN transport — hvis ingen kørsel/transport nævnes: udelad "transporttid_timer" helt fra JSON (ikke null, ikke 0).

Eksempel — FORKERT: udfoert_arbejde indeholder "Skiftet pakning", OG observationer indeholder "Læk under håndvask" — det er det samme problem, bare gentaget!
Eksempel — RIGTIGT: udfoert_arbejde indeholder "Skiftet pakning", observationer er [] — læk er løst, ikke en ny observation.

Transskription: {{transcription}}`

const inspektorPrompt = `Du er en professionel assistent for inspektører i Danmark — fraflytningssyn, indflytningssyn, byggepladinspektioner og tilstandsrapporter.

Brugeren har dikteret en talenotat fra en inspektion. Afgør hvilken TYPE inspektionen er:
- "fraflytning"  → lejer flytter ud, skader dokumenteres, evt. prisestimat
- "indflytning"  → ny lejer overtager, stand ved indflytning registreres som baseline
- "byggeplads"   → løbende gennemgang af byggeri — fremdrift, mangler, sikkerhed
- "tilstand"     → formel tilstandsvurdering — bruges ved køb/salg eller forsikring (K-klassifikation)

Strukturér notatet rum for rum. Returner KUN JSON i det format der matcher typen — se nedenfor.
Skriv på dansk. Udfyld kun felter der er nævnt i transskriptionen.

════════════════════════════════
TYPE: fraflytning
════════════════════════════════
{
  "type": "fraflytning",
  "title": "Kort beskrivelse (max 8 ord, inkludér gerne adresse)",
  "objekt": "Adresse eller lejemålsbeskrivelse hvis nævnt, ellers null",
  "dato": "Dato for syn hvis nævnt, ellers null",
  "parter": {
    "lejer": "Lejers navn hvis nævnt, ellers null",
    "udlejer": "Udlejers navn/firma hvis nævnt, ellers null"
  },
  "rum": [
    {
      "navn": "Rummets navn (Køkken, Stue, Soveværelse, Badeværelse, Gang, Kælder, etc.)",
      "observationer": [
        {
          "beskrivelse": "Præcis beskrivelse af fund",
          "alvorlighed": "minor | alvorlig | kritisk",
          "estimeret_pris": "Prisestimat hvis nævnt — fx '1.500-2.000 kr.' — ellers null"
        }
      ]
    }
  ],
  "generelle_observationer": ["Defekter og mangler der ikke tilhører ét specifikt rum — [] hvis ingen defekter"],
  "samlet_estimat": "Samlet prisestimat for udbedring hvis nævnt, ellers null",
  "naeste_skridt": ["Konkrete handlinger efter inspektionen"],
  "konklusion": "Samlet vurdering af lejemålets stand ved fraflytning (1-2 sætninger)",
  "tasks": ["Andre handlinger der ikke passer i ovenstående kategorier"]
}

════════════════════════════════
TYPE: indflytning
════════════════════════════════
{
  "type": "indflytning",
  "title": "Kort beskrivelse (max 8 ord, inkludér gerne adresse)",
  "objekt": "Adresse eller lejemålsbeskrivelse hvis nævnt, ellers null",
  "dato": "Dato for syn hvis nævnt, ellers null",
  "parter": {
    "lejer": "Ny lejers navn hvis nævnt, ellers null",
    "udlejer": "Udlejers navn/firma hvis nævnt, ellers null"
  },
  "rum": [
    {
      "navn": "Rummets navn",
      "observationer": [
        {
          "beskrivelse": "Eksisterende stand — hvad der registreres som baseline ved indflytning",
          "alvorlighed": "minor | alvorlig | kritisk"
        }
      ]
    }
  ],
  "generelle_observationer": ["Defekter og mangler der ikke tilhører ét specifikt rum — [] hvis ingen defekter"],
  "naeste_skridt": ["Konkrete handlinger efter inspektionen"],
  "konklusion": "Samlet vurdering af lejemålets stand ved indflytning (1-2 sætninger)",
  "tasks": ["Andre handlinger der ikke passer i ovenstående kategorier"]
}

════════════════════════════════
TYPE: byggeplads
════════════════════════════════
{
  "type": "byggeplads",
  "title": "Kort beskrivelse (max 8 ord, inkludér gerne projektets navn/adresse)",
  "objekt": "Projektbeskrivelse eller adresse hvis nævnt, ellers null",
  "dato": "Dato for inspektion hvis nævnt, ellers null",
  "fremdrift": "Eksplicit nævnt fremdriftsvurdering — fx 'ca. 60% færdigt, aflevering 15. august holder' — ellers null",
  "rum": [
    {
      "navn": "Område eller etage (fx 'Stueetage', '1. sal', 'Kælder', 'Facade nord', 'Tag')",
      "observationer": [
        {
          "beskrivelse": "Præcis beskrivelse af fund, mangel eller afvigelse",
          "alvorlighed": "minor | alvorlig | kritisk"
        }
      ]
    }
  ],
  "sikkerhedsfund": ["Kritiske sikkerhedsmæssige observationer der kræver øjeblikkelig handling — [] hvis ingen"],
  "generelle_observationer": ["Defekter og mangler der ikke tilhører ét specifikt område — [] hvis ingen defekter"],
  "bestillinger": ["Materialer, undersøgelser eller entreprenørhandlinger der skal igangsættes"],
  "naeste_skridt": ["Konkrete handlinger efter inspektionen"],
  "konklusion": "Samlet vurdering af byggeriets stand og fremdrift (1-2 sætninger)",
  "tasks": ["Andre handlinger der ikke passer i ovenstående kategorier"]
}

════════════════════════════════
TYPE: tilstand
════════════════════════════════
{
  "type": "tilstand",
  "title": "Kort beskrivelse (max 8 ord, inkludér gerne adresse)",
  "objekt": "Adresse eller ejendomsbeskrivelse hvis nævnt, ellers null",
  "dato": "Dato for rapport hvis nævnt, ellers null",
  "rum": [
    {
      "navn": "Bygningsdel eller rum (fx 'Tag', 'Facade', 'Kælder', 'Køkken', 'El-installation')",
      "observationer": [
        {
          "beskrivelse": "Præcis beskrivelse af fund",
          "klassifikation": "K1 | K2 | K3 | K4 | IB",
          "alvorlighed": "minor | alvorlig | kritisk"
        }
      ]
    }
  ],
  "generelle_observationer": ["Defekter og mangler der ikke tilhører én specifik bygningsdel — [] hvis ingen defekter"],
  "naeste_skridt": ["Konkrete handlinger efter inspektionen"],
  "konklusion": "Samlet vurdering af ejendommens tilstand (1-2 sætninger)",
  "tasks": ["Andre handlinger der ikke passer i ovenstående kategorier"]
}

Regler:
- Vælg KUN én type — den der passer bedst ud fra sproget i transskriptionen
- "rum" = strukturér præcist som inspektøren nævner dem. Rum uden defekter udelades helt fra rum[]-listen.
- "observationer" = KUN fund, mangler, skader eller afvigelser. Positive bekræftelser ("godkendt", "i orden", "ser flot ud", "korrekt", "klar") er IKKE observationer og udelades fra alle felter.
- "generelle_observationer" = kun defekter der IKKE tilhører et specifikt rum. Positive bekræftelser hører i "konklusion" — aldrig i generelle_observationer.
- "sikkerhedsfund" (kun byggeplads) = gentag KUN fund der er kritisk sikkerhedsmæssige — de må gerne også stå i rum[].observationer
- "naeste_skridt" skal inkludere ALLE handlinger med deadlines der nævnes — vær udtømmende. Deadlines bevares præcist: "inden morgendagens skift", "inden betonpumpning torsdag", "om to uger" skrives ordret.
- "fremdrift" (byggeplads): udfyld kun hvis fremdriftsstatus eksplicit nævnes med procent eller tidsramme — ellers null. Opfind aldrig procenttal eller afleveringsdatoer.
- Udelad observationer der eksplicit markeres som præ-eksisterende: "var der da han/hun/de flyttede ind", "eksisterede ved forrige lejer", "ikke lejers fejl/ansvar"
- "alvorlighed": minor = kosmetisk, alvorlig = funktionel/større udbedring, kritisk = sikkerhed/juridisk/øjeblikkelig handling
- "klassifikation" (kun tilstand): K1 = mindre alvorlig, K2 = alvorlig, K3 = kritisk, K4 = akut, IB = ingen bemærkning
- Inkludér KUN hvad der eksplicit nævnes i transskriptionen — opfind aldrig fund
- Returner KUN valid JSON — ingen forklaring udenfor JSON

Eksempel — FORKERT præ-eksisterende fund: transskription siger "gardinskinner var der da han flyttede ind" → gardinskinner optræder i observationer
Eksempel — RIGTIGT præ-eksisterende fund: gardinskinner udelades helt fra observationer

Eksempel — FORKERT fremdrift: transskription siger "vi er klar til næste fase" → fremdrift: "ca. 100% færdigt"
Eksempel — RIGTIGT fremdrift: transskription siger "vi er klar til næste fase" → fremdrift: null

Eksempel — FORKERT observationer: "Gipsvæggene er klar, finpuds ser flot ud" placeres i generelle_observationer
Eksempel — RIGTIGT observationer: positive bekræftelser udelades helt — generelle_observationer: [], konklusion opsummerer den gode stand

Transskription: {{transcription}}`

// Legacy vvs-prompt bevares så niches/vvs-doc'et har komplet historik.
// Refereres ikke af aktive flows (isActive: false + appIds: []).
const vvsPromptLegacy = `Du er en assistent for VVS-installatører og håndværkere i Danmark.

Brugeren har dikteret en talenotat fra et kundebesøg. Strukturér notatet i følgende JSON-format — udfyld KUN felter der er nævnt i transskriptionen, sæt resten til null eller []:

{
  "type": "vvs_visit",
  "title": "Kort beskrivelse af besøget (max 8 ord, inkludér gerne kundenavn/adresse)",
  "kunde": "Kundens navn og/eller adresse hvis nævnt, ellers null",
  "udfoert_arbejde": [
    { "beskrivelse": "Hvad blev lavet", "tid_min": null }
  ],
  "materialer_brugt": [
    { "vare": "Varebetegnelse", "antal": null, "enhed": "stk/meter/liter/etc" }
  ],
  "observationer": ["Liste af ting set men ikke udbedret"],
  "bestillinger": ["Ting der skal købes/bestilles"],
  "naeste_besoeg": "Hvad skal laves ved næste besøg, ellers null",
  "faktureringsgrundlag": "tid + arbejde + materialer — fx: 20 min: Pakning skiftet. Materialer: 2 stk. pakning 22mm",
  "tasks": ["Andre handlinger der ikke passer i ovenstående kategorier"]
}

Regler:
- Skriv på dansk
- "udfoert_arbejde" = kun det der faktisk ER lavet i dag
- "observationer" = ting der blev SET men IKKE udbedret i dag.
- "bestillinger" = varer/materialer der mangler og skal købes
- "faktureringsgrundlag" skal altid udfyldes med tid (hvis nævnt) + arbejde + materialer
- Returner KUN valid JSON — ingen forklaring udenfor JSON

Transskription: {{transcription}}`

// ─────────────────────────────────────────────────────────────────────────────
// Niche Capabilities — Fase 2: population (22. maj 2026)
//
// extraFields deklarerer hvilke felter prompten producerer — bruges af
// Android's Dynamic Field Renderer til at rendere noter uden hardcoded typer.
//
// For niches med type-diskriminator (generel, inspektor) er extraFields
// FORENINGEN af felter på tværs af alle undertyper. Android-rendereren
// håndterer pr-type-rendering via sit Renderer Registry.
//
// voiceCommands + metadataFlags er tomme per-niche i V1 — alle app-globale.
// Niche-specifikke commands (fx "tilføj rum" for inspektor) er Fase 3.
//
// Se EchoLima_Niche_Capabilities_Architecture.md §7 for migrations-plan.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Fælles ANALYSIS_SUFFIX-felter (alle niches) ─────────────────────────────
// Disse tre felter appender ALTID til alle niche-prompts via ANALYSIS_SUFFIX
// i ai.ts. De er identiske på tværs af niches, så vi definerer dem centralt.
const analysisSuffixFields: ExtraFieldDef[] = [
  { id: 'suggested_improvements', displayName: { da: 'Forslag',                 en: 'Suggestions' },          type: 'string[]', location: 'metadata' },
  { id: 'gaps',                   displayName: { da: 'Mangler',                 en: 'Gaps' },                 type: 'string[]', location: 'metadata' },
  { id: 'follow_up_questions',    displayName: { da: 'Opfølgningsspørgsmål',    en: 'Follow-up questions' },  type: 'string[]', location: 'metadata' }
]

// ─── generel extraFields (v1.2.0) ────────────────────────────────────────────
// Generel producerer 5 type-skemaer (moede/opgave/beslutning/ide/note).
// extraFields er FORENINGEN af alle felter på tværs af de 5 typer.
// Android-rendereren filtrerer efter 'type'-diskriminatoren ved rendering.
const generelExtraFields: ExtraFieldDef[] = [
  // Fælles på tværs af alle 5 typer
  { id: 'title',                   displayName: { da: 'Titel',                  en: 'Title' },                type: 'string',   location: 'top_level' },
  { id: 'summary',                 displayName: { da: 'Resume',                 en: 'Summary' },              type: 'string',   location: 'top_level' },
  { id: 'tasks',                   displayName: { da: 'Opgaver',                en: 'Tasks' },                type: 'object[]', location: 'top_level' },
  { id: 'open_questions',          displayName: { da: 'Åbne spørgsmål',         en: 'Open questions' },       type: 'string[]', location: 'top_level' },
  // Type: moede
  { id: 'deltagere',               displayName: { da: 'Deltagere',              en: 'Participants' },         type: 'string[]', location: 'top_level' },
  { id: 'beslutninger',            displayName: { da: 'Beslutninger',           en: 'Decisions' },            type: 'string[]', location: 'top_level' },
  { id: 'naeste_moede',            displayName: { da: 'Næste møde',             en: 'Next meeting' },         type: 'string',   location: 'top_level' },
  // Type: beslutning
  { id: 'beslutning',              displayName: { da: 'Beslutning',             en: 'Decision' },             type: 'string',   location: 'top_level' },
  { id: 'begrundelse',             displayName: { da: 'Begrundelse',            en: 'Reasoning' },            type: 'string',   location: 'top_level' },
  { id: 'alternativer_fravalgt',   displayName: { da: 'Fravalgte alternativer', en: 'Rejected alternatives' },type: 'string[]', location: 'top_level' },
  { id: 'konsekvenser',            displayName: { da: 'Konsekvenser',           en: 'Consequences' },         type: 'string[]', location: 'top_level' },
  // Type: ide
  { id: 'ide_beskrivelse',         displayName: { da: 'Idé-beskrivelse',        en: 'Idea description' },     type: 'string',   location: 'top_level' },
  { id: 'fordele',                 displayName: { da: 'Fordele',               en: 'Advantages' },            type: 'string[]', location: 'top_level' },
  { id: 'udfordringer',            displayName: { da: 'Udfordringer',           en: 'Challenges' },           type: 'string[]', location: 'top_level' },
  ...analysisSuffixFields
  // Total: 17 entries
]

// ─── haandvaerker extraFields (v1.3.0) ───────────────────────────────────────
// Ét fast type-skema: haandvaerker_visit
const haandvaerkerExtraFields: ExtraFieldDef[] = [
  { id: 'title',                displayName: { da: 'Titel',                en: 'Title' },               type: 'string',   location: 'top_level' },
  { id: 'kunde',                displayName: { da: 'Kunde',                en: 'Customer' },            type: 'string',   location: 'top_level' },
  { id: 'transporttid_timer',   displayName: { da: 'Transporttid (timer)', en: 'Travel time (hours)' }, type: 'number',   location: 'top_level' },
  { id: 'udfoert_arbejde',      displayName: { da: 'Udført arbejde',       en: 'Work performed' },      type: 'object[]', location: 'top_level' },
  { id: 'materialer_brugt',     displayName: { da: 'Materialer brugt',     en: 'Materials used' },      type: 'object[]', location: 'top_level' },
  { id: 'observationer',        displayName: { da: 'Observationer',        en: 'Observations' },        type: 'string[]', location: 'top_level' },
  { id: 'bestillinger',         displayName: { da: 'Bestillinger',         en: 'Orders' },              type: 'string[]', location: 'top_level' },
  { id: 'naeste_besoeg',        displayName: { da: 'Næste besøg',          en: 'Next visit' },          type: 'string',   location: 'top_level' },
  { id: 'faktureringsgrundlag', displayName: { da: 'Faktureringsgrundlag', en: 'Invoicing basis' },     type: 'string',   location: 'top_level' },
  { id: 'tasks',                displayName: { da: 'Øvrige opgaver',       en: 'Other tasks' },         type: 'string[]', location: 'top_level' },
  ...analysisSuffixFields
  // Total: 13 entries
]

// ─── inspektor extraFields (v1.1.0) ──────────────────────────────────────────
// Inspektor producerer 4 type-skemaer (fraflytning/indflytning/byggeplads/tilstand).
// extraFields er FORENINGEN af felter på tværs af alle 4 typer.
// NB: 'parter' bruger type: 'object' (ikke 'object[]') — nested single objekt
// { lejer: string|null, udlejer: string|null }. Type-union udvidet 22. maj 2026.
const inspektorExtraFields: ExtraFieldDef[] = [
  // Fælles på tværs af alle 4 inspektionstyper
  { id: 'title',                   displayName: { da: 'Titel',                      en: 'Title' },                type: 'string',   location: 'top_level' },
  { id: 'objekt',                  displayName: { da: 'Objekt/adresse',             en: 'Object/address' },       type: 'string',   location: 'top_level' },
  { id: 'dato',                    displayName: { da: 'Dato',                       en: 'Date' },                 type: 'string',   location: 'top_level' },
  { id: 'rum',                     displayName: { da: 'Rum/områder',                en: 'Rooms/areas' },          type: 'object[]', location: 'top_level' },
  { id: 'generelle_observationer', displayName: { da: 'Generelle observationer',    en: 'General observations' }, type: 'string[]', location: 'top_level' },
  { id: 'naeste_skridt',           displayName: { da: 'Næste skridt',              en: 'Next steps' },            type: 'string[]', location: 'top_level' },
  { id: 'konklusion',              displayName: { da: 'Konklusion',                 en: 'Conclusion' },           type: 'string',   location: 'top_level' },
  { id: 'tasks',                   displayName: { da: 'Øvrige opgaver',             en: 'Other tasks' },          type: 'string[]', location: 'top_level' },
  // Type: fraflytning + indflytning — nested single objekt { lejer, udlejer }
  { id: 'parter',                  displayName: { da: 'Parter',                     en: 'Parties' },              type: 'object',   location: 'top_level' },
  // Type: fraflytning
  { id: 'samlet_estimat',          displayName: { da: 'Samlet estimat',             en: 'Total estimate' },       type: 'string',   location: 'top_level' },
  // Type: byggeplads
  { id: 'fremdrift',               displayName: { da: 'Fremdrift',                  en: 'Progress' },             type: 'string',   location: 'top_level' },
  { id: 'sikkerhedsfund',          displayName: { da: 'Sikkerhedsfund',             en: 'Safety findings' },      type: 'string[]', location: 'top_level' },
  { id: 'bestillinger',            displayName: { da: 'Bestillinger',               en: 'Orders' },               type: 'string[]', location: 'top_level' },
  ...analysisSuffixFields
  // Total: 16 entries
]

// ─── Capabilities-hjælpere ────────────────────────────────────────────────────
function makeCapabilities(extraFields: ExtraFieldDef[]): Capabilities {
  return {
    extraFields,
    voiceCommands: [],   // Per-niche voice commands er tomme i V1
    metadataFlags: []    // Per-niche metadata flags er tomme i V1
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Niche-definitioner
//
// generel       — aktiv, alle tiers
// haandvaerker  — aktiv, tier_basic+ (REBRANDED fra vvs 20. maj 2026)
// vvs           — LEGACY, isActive: false, appIds: [] (bevaret som arkiv)
//
// Når gæsteliste-app'en bygges senere, oprettes fx niches/generel_gaesteliste
// med appIds: ["gaesteliste"].
// ─────────────────────────────────────────────────────────────────────────────

const niches = [
  {
    id: 'generel',
    displayName: { da: 'Generel', en: 'General' },
    description: {
      da: 'Generisk produktivitetsassistent med type-klassifikation',
      en: 'Generic productivity assistant with type classification'
    },
    prompt: generelPrompt,
    minTier: 'tier_free',
    appIds: ['echolima'],
    isActive: true,
    order: 0,
    version: '1.2.0',  // 22. maj 2026: Fase 2 — extraFields populeret (17 entries)
    capabilities: makeCapabilities(generelExtraFields)
  },
  {
    id: 'haandvaerker',
    displayName: { da: 'Håndværker', en: 'Tradesperson' },
    description: {
      da: 'VVS, elektriker, murer, tømrer, tagdækker — service-besøg med struktureret rapport',
      en: 'Plumber, electrician, mason, carpenter, roofer — service visit with structured report'
    },
    prompt: haandvaerkerPrompt,
    minTier: 'tier_basic',
    appIds: ['echolima'],
    isActive: true,
    order: 2,
    version: '1.3.0',  // 22. maj 2026: Fase 2 — extraFields populeret (13 entries)
    capabilities: makeCapabilities(haandvaerkerExtraFields)
  },
  {
    id: 'inspektor',
    displayName: { da: 'Inspektør', en: 'Inspector' },
    description: {
      da: 'Fraflytningssyn, indflytningssyn, byggeplads og tilstandsrapport — rum-for-rum struktur',
      en: 'Move-out, move-in, building site and condition report — room-by-room structure'
    },
    prompt: inspektorPrompt,
    minTier: 'tier_basic',
    appIds: ['echolima'],
    isActive: true,
    order: 3,
    version: '1.1.0',  // 22. maj 2026: Fase 2 — extraFields populeret (16 entries)
    capabilities: makeCapabilities(inspektorExtraFields)
  },
  {
    id: 'vvs',
    displayName: { da: 'VVS & Håndværker (arkiveret)', en: 'Plumber & Craftsman (archived)' },
    description: {
      da: 'ARKIVERET 20. maj 2026 — erstattet af niches/haandvaerker. Bevares for klient-cache-kompatibilitet.',
      en: 'ARCHIVED 20 May 2026 — replaced by niches/haandvaerker. Kept for client-cache compatibility.'
    },
    prompt: vvsPromptLegacy,
    minTier: 'tier_basic',
    appIds: [],          // Tom → vises IKKE i GET /niches-responses
    isActive: false,     // Inaktiv → kan ikke vælges af klient eller modtages som nicheId
    order: 99,           // Sidst — irrelevant da den er filtreret fra
    version: '1.0'       // Legacy — ingen capabilities-felt (ikke nødvendigt for arkiveret niche)
  }
]

async function seedNiches() {
  console.log('Seeder niches til Firestore...')
  const batch = db.batch()

  for (const niche of niches) {
    const { id, ...data } = niche
    const ref = db.collection('niches').doc(id)
    batch.set(ref, {
      ...data,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    const statusTag = niche.isActive ? `aktiv, ${niche.appIds.join(',')}` : 'ARKIVERET'
    const capCount = ('capabilities' in niche && niche.capabilities)
      ? `extraFields: ${niche.capabilities.extraFields.length}`
      : 'ingen capabilities'
    console.log(`  ✓ ${niche.id.padEnd(15)} v${niche.version.padEnd(6)} (${statusTag}, ${capCount})`)
  }

  await batch.commit()
  console.log(`\n✅ ${niches.length} niches oprettet/opdateret i Firestore!`)
  process.exit(0)
}

seedNiches().catch(err => {
  console.error('Fejl:', err)
  process.exit(1)
})
