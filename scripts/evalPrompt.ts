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

// ─────────────────────────────────────────────────────────────────────────────
// Scoring prompt (bruges med --score flag)
// ─────────────────────────────────────────────────────────────────────────────

function scoringPrompt(transcription: string, baseline: string, niche: string): string {
  return `Du er evaluator for et AI-system til håndværkere.

En VVS-installatør har dikteret denne talenotat:
---
${transcription}
---

To AI-systemer har analyseret notatet. Score dem begge på disse 5 kriterier (0-3 point hver):

KRITERIUM 1 — STRUKTUR (0=alt i prosa, 3=perfekt kategori-adskillelse)
KRITERIUM 2 — FAGTERMINOLOGI (0=ingen, 3=præcis fagterminologi bevaret)
KRITERIUM 3 — FAKTURERINGSRELEVANS (0=intet, 3=komplet: tid + materialer)
KRITERIUM 4 — HANDLINGSPRÆCISION (0=vage, 3=præcise og kategoriserede)
KRITERIUM 5 — NØJAGTIGHED (0=fakta tabt, 3=alt fra transskriptionen bevaret)

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
    throw new Error(`Ukendt niche: ${nicheArg}`)
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
        scoringPrompt(sample.transcription, baselineRaw, nicheRaw),
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
