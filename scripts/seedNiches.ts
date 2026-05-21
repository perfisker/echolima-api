import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
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
3. En liste af konkrete opgaver/handlinger
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
    version: '1.0'
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
    version: '1.1.0'  // 21. maj 2026: tid_min → tid_timer + transporttid_timer top-level felt
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
    version: '1.0'
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
    console.log(`  ✓ ${niche.id.padEnd(15)} (minTier: ${niche.minTier}, ${statusTag})`)
  }

  await batch.commit()
  console.log(`\n✅ ${niches.length} niches oprettet/opdateret i Firestore!`)
  process.exit(0)
}

seedNiches().catch(err => {
  console.error('Fejl:', err)
  process.exit(1)
})
