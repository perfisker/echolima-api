/**
 * evalPrompt.ts — AidKick Prompt Evaluering
 *
 * Kører baseline-prompt og niche-specifik prompt mod de samme transskriptioner
 * og printer output side om side så du kan sammenligne kvaliteten.
 *
 * Brug:
 *   npx ts-node scripts/evalPrompt.ts --niche=vvs
 *   npx ts-node scripts/evalPrompt.ts --niche=vvs --sample=1
 *   npx ts-node scripts/evalPrompt.ts --niche=vvs --score
 *
 * Forudsætninger:
 *   - OPENAI_API_KEY sat i .env eller miljøet
 *   - npx ts-node installeret (npx ts-node --version)
 */

import OpenAI from 'openai'
import * as dotenv from 'dotenv'
import * as path from 'path'

dotenv.config({ path: path.resolve(__dirname, '../.env') })

// ─────────────────────────────────────────────────────────────────────────────
// CLI-args
// ─────────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const nicheArg = (args.find(a => a.startsWith('--niche=')) ?? '--niche=vvs').split('=')[1]
const sampleArg = args.find(a => a.startsWith('--sample='))?.split('=')[1]
const scoreMode = args.includes('--score')
const sampleFilter = sampleArg ? parseInt(sampleArg) : null

// ─────────────────────────────────────────────────────────────────────────────
// Sample-transskriptioner
// ─────────────────────────────────────────────────────────────────────────────

interface Sample {
  id: number
  label: string
  niche: string
  transcription: string
}

const samples: Sample[] = [
  {
    id: 1,
    niche: 'vvs',
    label: 'Pakkeskift + radiatorobservation',
    transcription: `Okay jeg er færdig hos Thomsens, Søndergade 14. Badeværelset stuen — der var et læk under håndvasken, det var pakningerne i sifon-koblingen der var møre. Jeg har skiftet dem, tog 20 minutter. Brugte to pakninger fra bilen, 22 millimeter. Varmt vandsystemet oppe på 1. sal er okay, ingen tryk-problemer. Men jeg lagde mærke til at termostaten på radiatoren i gangen er stiv, kunden spurgte om vi kan kigge på det næste gang. Og husk at bestille nye 22 millimeter pakninger til bilen, vi er ved at løbe tør.`
  },
  {
    id: 2,
    niche: 'vvs',
    label: 'Badeværelsesrenovering — tilbud og opmåling',
    transcription: `Hos Petersens, Elmevej 7 i Odense. Jeg har opmålt badeværelset til nyrenovering. Gulvet er 4,2 kvadratmeter, vægge samlet 18 kvadratmeter. Kunden vil have nye fliser overalt, nyt toilet og ny blandingsbatteri til bruseren. Eksisterende rør er okay, skal ikke lægges om. Jeg estimerer arbejdstid til to dage, plus materialerne. Huusk at lave tilbud til dem inden fredag — de vil gerne starte i næste måned. Og husk at spørge om de har valgt fliser endnu eller om de skal have hjælp til det.`
  },
  {
    id: 3,
    niche: 'vvs',
    label: 'Akutkald — vandrørsbrud',
    transcription: `Akutkald afsluttet, Havnegade 33, 2. sal. Der var et rørsbrud på det kolde vand under køkkenvasken, formentlig frost-skade fra vinteren. Jeg har skiftet et stykke kobberrør, cirka 40 centimeter, og sat ny kobling på. Brugte 40 cm kobberrør 15 millimeter og to preskobling fra bilen. Arbejdstid var halvanden time inklusiv transport inden for byen. Der er vandskade på underskabene i køkkenet — det er ikke mit område men kunden skal have fat i en tømrer eller et skadesfirma. Husk at udfylde skadesrapport inden vi lukker sagen.`
  },
  {
    id: 4,
    niche: 'vvs',
    label: 'Service på varmepumpe',
    transcription: `Service hos Larsens, Rosenvej 12. Luft-til-vand varmepumpe, mærke Daikin, model Altherma. Serviceeftersyn gennemført — filter renset, kølemiddeltryk okay, ingen lækager. Virkningsgraden er faldet lidt ifølge loggen, kunden siger den kører mere end tidligere. Jeg mistænker at bygningen trænger til efterisolering snarere end et problem med pumpen selv. Arbejdstid 45 minutter. Ingen materialer brugt. Anbefalet kunden at kontakte en energikonsulent om isolering. Næste service om et år.`
  },
  {
    id: 5,
    niche: 'vvs',
    label: 'Ny bruseinstallation + fund af skjult skade',
    transcription: `Færdig hos Nielsens på Strandvejen 88. Installeret ny brusearmatur i badeværelset på 1. sal, tog halvanden time. Brugte ny bruserarmatur fra lageret — Grohe Euphoria, og silicone til tætning. Men da jeg åbnede væggen bag bruseren fandt jeg skimmelsvamp bag fliserne, ret massivt. Det er ikke noget jeg kan fikse indenfor dette job. Det skal kunden vide om med det samme — ring til dem inden du kører hjem. De skal have fat i en skimmelekspert. Husk at tage foto af skaden inden du lukker væggen igen.`
  },

  // ── Inspektør-samples ─────────────────────────────────────────────────────
  {
    id: 1,
    niche: 'inspektor',
    label: 'Fraflytning — 3 rum, prisestimater, præ-eksisterende fund',
    transcription: `Okay fraflytningssyn på Birkevej 12, 2. sal. Lejer hedder Thomas Eriksen. Starter i entréen — der er et stort hul i væggen ved lyskontakten, alvorligt, skal sparkles og males, estimerer 800 kroner. I stuen er der ridser i parketgulvet ved vinduespartiet, minor. Gardinskinner mangler, det var der da han flyttede ind, det er ikke hans fejl. I badeværelset er der fugt bag badekarret, det er kritisk — der skal fliser af, fugt udbedres og ny fuge. Estimat 4.000 til 6.000 kroner. Samlet estimat 5.000 til 7.000 kroner. Næste skridt er at sende rapporten til udlejer inden fredag.`
  },
  {
    id: 2,
    niche: 'inspektor',
    label: 'Indflytning — baseline registrering, 2 rum',
    transcription: `Indflytningssyn Rosenvænget 4, stuen. Ny lejer er Mette Andersen der overtager 1. juni. I køkkenet er fronterne lidt slidte, det er normalt slid, minor. Underskabet under vasken er misfarvet, alvorligt men var der ved forrige lejer — registreres som baseline. I stuen er malingen gul ved vinduerne, minor, solskader. Generelt er lejligheden i rimelig stand til sin alder fra 1973.`
  },
  {
    id: 3,
    niche: 'inspektor',
    label: 'Byggeplads — fremdrift, sikkerhedsfund, 3 områder',
    transcription: `Byggepladindspektion Strandvejen 88, råhus etape 2. Fremdriften er ca. 70 procent færdig, vi er lidt bagud men afleveringen 15. august holder stadig. På stueetagen er betonarbejdet i orden, men der mangler forskallingen ved søjle 3 — alvorligt, entreprenøren skal på det inden betonpumpning torsdag. På 1. sal er der ingen gelænder ved trappeåbningen mod øst — det er kritisk sikkerhedsfund, stilladser skal sættes op inden morgendagens skift. Taget er generelt okay, men der er en vandpøl i nordøsthjørnet der antyder en fald-fejl — alvorligt. Næste inspektion om to uger.`
  },
  {
    id: 4,
    niche: 'inspektor',
    label: 'Tilstandsrapport — K-klassifikation, parcelhus 1968',
    transcription: `Tilstandsrapport Elmegade 7, parcelhus fra 1968. Taget har revnede tagsten i sydvendt flade, K2. Tagrender er rustne og hænger skævt ved gavlen, K2. I kælderen er der tegn på opstigende fugt ved fundamentsvæg mod nord, K3. El-installationen er fra original byggeår og bør gennemgås af autoriseret el-installatør, K2. Vinduer i stuen er tærede og utætte, K1. Generelt fremstår ejendommen som en typisk 1960er-villa der trænger til løbende vedligehold men ikke akutte indgreb.`
  },
  {
    id: 5,
    niche: 'inspektor',
    label: 'Byggeplads uden fund — ren gennemgang',
    transcription: `Hurtig runde på Havnevej 3, etage 2. Gipsvæggene er klar, finpuds ser flot ud. Maling på gangen er godkendt. El-føringsrør er trukket korrekt. Ingen fund i dag, alt ser fint ud. Vi er klar til gulvlægning næste uge.`
  }
]

// ─────────────────────────────────────────────────────────────────────────────
// Prompts
// ─────────────────────────────────────────────────────────────────────────────

function baselinePrompt(transcription: string): string {
  return `Du er en produktivitetsassistent. Analyser denne transskription og returner JSON med:
1. En kort sigende titel (max 6 ord)
2. Et kort resume (2-3 sætninger)
3. En liste af konkrete opgaver/handlinger
Returner KUN dette JSON format:
{
    "title": "...",
    "summary": "...",
    "tasks": ["opgave 1", "opgave 2"]
}
Transskription: ${transcription}`
}

function vvsPromptV1(transcription: string): string {
  return `Du er en assistent for VVS-installatører og håndværkere i Danmark.

Brugeren har dikteret en talenotat fra et kundebesøg.
Strukturér notatet i følgende JSON-format — udfyld KUN felter der er nævnt i transskriptionen, sæt resten til null eller []:

{
  "title": "Kort beskrivelse af besøget (max 8 ord, inkludér gerne kundenavn/adresse)",
  "kunde": "Kundens navn og/eller adresse hvis nævnt, ellers null",
  "udfoert_arbejde": [
    {
      "beskrivelse": "Hvad blev lavet",
      "tid_min": null
    }
  ],
  "materialer_brugt": [
    {
      "vare": "Varebetegnelse",
      "antal": null,
      "enhed": "stk/meter/liter/etc"
    }
  ],
  "observationer": ["Ting der blev bemærket men IKKE udbedret — kræver opfølgning"],
  "bestillinger": ["Ting der skal købes/bestilles inden næste besøg"],
  "naeste_besoeg": "Hvad skal laves ved næste besøg, hvis nævnt — ellers null",
  "faktureringsgrundlag": "Kort opsummering af hvad der kan faktureres: arbejde + materialer",
  "tasks": ["Andre handlinger der ikke passer i ovenstående kategorier"]
}

Regler:
- Skriv på dansk
- "udfoert_arbejde" = kun det der faktisk ER lavet i dag
- "observationer" = ting der blev set/nævnt men som IKKE er udbedret endnu
- "bestillinger" = varer/materialer der mangler og skal købes
- "faktureringsgrundlag" skal altid udfyldes hvis der er udført arbejde
- Returner KUN valid JSON — ingen forklaring udenfor JSON

Transskription: ${transcription}`
}

function inspektorPromptV1(transcription: string): string {
  return `Du er en professionel assistent for inspektører i Danmark — fraflytningssyn, indflytningssyn, byggepladinspektioner og tilstandsrapporter.

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
- "naeste_skridt" skal inkludere ALLE handlinger med deadlines der nævnes — vær udtømmende. Deadlines bevares præcist.
- "fremdrift" (byggeplads): udfyld kun hvis fremdriftsstatus eksplicit nævnes med procent eller tidsramme — ellers null.
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

Transskription: ${transcription}`
}

// ─────────────────────────────────────────────────────────────────────────────
// Scoring prompt (bruges med --score flag)
// ─────────────────────────────────────────────────────────────────────────────

function scoringPrompt(transcription: string, baseline: string, niche: string, nicheId = 'vvs'): string {
  const nicheLabel = nicheId === 'inspektor'
    ? 'En inspektør har dikteret denne talenotat fra en inspektion'
    : 'En VVS-installatør har dikteret denne talenotat'

  const criteria = nicheId === 'inspektor'
    ? `KRITERIUM 1 — TYPE-DETEKTION (0=forkert type, 3=præcis og konsistent)
KRITERIUM 2 — RUM-STRUKTUR (0=alt i prosa, 3=perfekt rum-for-rum inddeling)
KRITERIUM 3 — OBSERVATIONS-PRÆCISION (0=fund tabt/forvansket, 3=alt bevaret)
KRITERIUM 4 — FAGTERMINOLOGI (0=ingen, 3=præcis: K-klassifikation, alvorlighed, sikkerhedsfund)
KRITERIUM 5 — INGEN HALLUCINATION (0=opfinder fund, 3=kun hvad der er nævnt)`
    : `KRITERIUM 1 — STRUKTUR (0=alt i prosa, 3=perfekt kategori-adskillelse)
KRITERIUM 2 — FAGTERMINOLOGI (0=ingen, 3=præcis fagterminologi bevaret)
KRITERIUM 3 — FAKTURERINGSRELEVANS (0=intet, 3=komplet: tid + materialer)
KRITERIUM 4 — HANDLINGSPRÆCISION (0=vage, 3=præcise og kategoriserede)
KRITERIUM 5 — NØJAGTIGHED (0=fakta tabt, 3=alt fra transskriptionen bevaret)`

  return `Du er evaluator for et AI-system til professionelle brugere.

${nicheLabel}:
---
${transcription}
---

To AI-systemer har analyseret notatet. Score dem begge på disse 5 kriterier (0-3 point hver):

${criteria}

SYSTEM A (baseline):
${baseline}

SYSTEM B (niche):
${niche}

Returner KUN dette JSON:
{
  "system_a": {
    "struktur": 0,
    "fagterminologi": 0,
    "faktureringsrelevans": 0,
    "handlingspraecision": 0,
    "nojagtighed": 0,
    "total": 0,
    "kommentar": "Kort vurdering"
  },
  "system_b": {
    "struktur": 0,
    "fagterminologi": 0,
    "faktureringsrelevans": 0,
    "handlingspraecision": 0,
    "nojagtighed": 0,
    "total": 0,
    "kommentar": "Kort vurdering"
  },
  "vinder": "A eller B",
  "forbedring_pct": 0
}`
}

// ─────────────────────────────────────────────────────────────────────────────
// Hjælpefunktioner
// ─────────────────────────────────────────────────────────────────────────────

function separator(char = '─', width = 80): string {
  return char.repeat(width)
}

function printHeader(text: string) {
  console.log('\n' + separator('═'))
  console.log(`  ${text}`)
  console.log(separator('═'))
}

function printSection(title: string) {
  console.log('\n' + separator())
  console.log(`  ${title}`)
  console.log(separator())
}

function prettyJson(obj: unknown): string {
  return JSON.stringify(obj, null, 2)
}

async function callOpenAI(client: OpenAI, prompt: string, label: string): Promise<string> {
  process.stdout.write(`  Kalder OpenAI (${label})...`)
  const start = Date.now()
  const completion = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 1000,
    response_format: { type: 'json_object' }
  })
  const elapsed = ((Date.now() - start) / 1000).toFixed(1)
  console.log(` ${elapsed}s ✓`)
  return completion.choices[0].message.content ?? '{}'
}

async function callOpenAIRaw(client: OpenAI, prompt: string, label: string): Promise<string> {
  process.stdout.write(`  Kalder OpenAI (${label})...`)
  const start = Date.now()
  const completion = await client.chat.completions.create({
    model: 'gpt-4o',               // Bruger gpt-4o til scoring — bedre reasoning
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 800,
    response_format: { type: 'json_object' }
  })
  const elapsed = ((Date.now() - start) / 1000).toFixed(1)
  console.log(` ${elapsed}s ✓`)
  return completion.choices[0].message.content ?? '{}'
}

// ─────────────────────────────────────────────────────────────────────────────
// Hoved-logik
// ─────────────────────────────────────────────────────────────────────────────

async function runEval() {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    console.error('❌  OPENAI_API_KEY er ikke sat. Tjek din .env-fil.')
    process.exit(1)
  }

  const client = new OpenAI({ apiKey })

  // Filtrer samples
  const toTest = sampleFilter
    ? samples.filter(s => s.id === sampleFilter && s.niche === nicheArg)
    : samples.filter(s => s.niche === nicheArg)

  if (toTest.length === 0) {
    console.error(`❌  Ingen samples fundet for niche="${nicheArg}"${sampleFilter ? ` sample=${sampleFilter}` : ''}`)
    process.exit(1)
  }

  // Vælg niche-prompt
  const getNichePrompt = (transcription: string): string => {
    if (nicheArg === 'vvs') return vvsPromptV1(transcription)
    if (nicheArg === 'inspektor') return inspektorPromptV1(transcription)
    throw new Error(`Ukendt niche: ${nicheArg}. Tilgængelige: vvs, inspektor`)
  }

  printHeader(`AidKick Prompt Evaluering — niche: ${nicheArg.toUpperCase()} | ${toTest.length} sample(s) | score: ${scoreMode}`)

  const allScores: { baselineTotal: number; nicheTotal: number }[] = []

  for (const sample of toTest) {
    printSection(`Sample #${sample.id}: ${sample.label}`)

    console.log('\n📋 Transskription:')
    console.log(`   "${sample.transcription.slice(0, 120)}${sample.transcription.length > 120 ? '...' : ''}"`)

    // Kald begge prompts parallelt
    const [baselineRaw, nicheRaw] = await Promise.all([
      callOpenAI(client, baselinePrompt(sample.transcription), 'baseline'),
      callOpenAI(client, getNichePrompt(sample.transcription), `${nicheArg} v1`)
    ])

    let baselineParsed: unknown, nicheParsed: unknown
    try { baselineParsed = JSON.parse(baselineRaw) } catch { baselineParsed = { error: 'JSON parse fejl', raw: baselineRaw } }
    try { nicheParsed = JSON.parse(nicheRaw) } catch { nicheParsed = { error: 'JSON parse fejl', raw: nicheRaw } }

    console.log('\n🔵 BASELINE OUTPUT:')
    console.log(prettyJson(baselineParsed))

    console.log(`\n🟢 ${nicheArg.toUpperCase()} v1 OUTPUT:`)
    console.log(prettyJson(nicheParsed))

    // Scoring (kun med --score flag)
    if (scoreMode) {
      console.log('\n⚖️  Scorer med GPT-4o...')
      const scoreRaw = await callOpenAIRaw(
        client,
        scoringPrompt(sample.transcription, baselineRaw, nicheRaw, nicheArg),
        'scoring'
      )
      let score: any
      try { score = JSON.parse(scoreRaw) } catch { score = { error: 'Parse fejl', raw: scoreRaw } }

      if (!score.error) {
        const a = score.system_a
        const b = score.system_b
        console.log('\n📊 Scorecard:')
        console.log(`   ${'Kriterium'.padEnd(24)} ${'Baseline'.padEnd(10)} ${nicheArg.toUpperCase()} v1`)
        console.log(`   ${'─'.repeat(44)}`)
        const criteria = ['struktur', 'fagterminologi', 'faktureringsrelevans', 'handlingspraecision', 'nojagtighed']
        for (const c of criteria) {
          const label = c.charAt(0).toUpperCase() + c.slice(1)
          console.log(`   ${label.padEnd(24)} ${String(a[c]).padEnd(10)} ${b[c]}`)
        }
        console.log(`   ${'─'.repeat(44)}`)
        console.log(`   ${'TOTAL'.padEnd(24)} ${String(a.total).padEnd(10)} ${b.total} / 15`)
        console.log(`\n   Vinder: ${score.vinder === 'B' ? '🟢' : '🔵'} System ${score.vinder}`)
        console.log(`   Forbedring: +${score.forbedring_pct}%`)
        console.log(`\n   Baseline: "${a.kommentar}"`)
        console.log(`   Niche:    "${b.kommentar}"`)

        allScores.push({ baselineTotal: a.total, nicheTotal: b.total })
      } else {
        console.log('   ⚠️  Scoring fejlede:', score)
      }
    }
  }

  // Samlet scoreopsummering
  if (scoreMode && allScores.length > 1) {
    const avgBaseline = allScores.reduce((s, r) => s + r.baselineTotal, 0) / allScores.length
    const avgNiche = allScores.reduce((s, r) => s + r.nicheTotal, 0) / allScores.length
    const improvement = ((avgNiche - avgBaseline) / avgBaseline * 100).toFixed(0)

    printSection('SAMLET RESULTAT')
    console.log(`   Samples testet:        ${allScores.length}`)
    console.log(`   Baseline gennemsnit:   ${avgBaseline.toFixed(1)} / 15`)
    console.log(`   ${nicheArg.toUpperCase()} v1 gennemsnit:   ${avgNiche.toFixed(1)} / 15`)
    console.log(`   Samlet forbedring:     +${improvement}%`)
    console.log(`   Produktionsklar:       ${avgNiche >= 11 ? '✅  JA (≥11/15)' : '❌  NEJ (<11/15 — iterér på prompten)'}`)
  }

  console.log('\n' + separator('═') + '\n')
}

runEval().catch(err => {
  console.error('❌  Eval fejlede:', err)
  process.exit(1)
})
