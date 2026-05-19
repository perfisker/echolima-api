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
// generel = kopi af den eksisterende analyzePrompt() fra routes/ai.ts.
// Bevares for backward-compat: hvis appen sender nicheId="generel" eller
// nicheId mangler helt, bruges denne prompt.
//
// vvs = ny niche-specifik prompt for VVS-installatører og håndværkere.
// Strukturerer kundebesøg i et JSON-skema der matcher fakturerings-flowet.
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

const vvsPrompt = `Du er en assistent for VVS-installatører og håndværkere i Danmark.

Brugeren har dikteret en talenotat fra et kundebesøg. Strukturér notatet i følgende JSON-format — udfyld KUN felter der er nævnt i transskriptionen, sæt resten til null eller []:

{
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
- "observationer" = ting der blev SET men IKKE udbedret i dag. Tjek: hvis noget allerede optræder i "udfoert_arbejde", må det IKKE gentages i "observationer". Kun nye fund der kræver fremtidig handling.
- "bestillinger" = varer/materialer der mangler og skal købes
- "faktureringsgrundlag" skal altid udfyldes med tid (hvis nævnt) + arbejde + materialer
- Hvis transport nævnes som "X tid hver vej", beregn den samlede transporttid som tur + retur (dvs. × 2) og skriv begge dele: fx "2 timer transport (1 time hver vej)"
- Inkludér KUN hvad der eksplicit er nævnt i transskriptionen. Opfind aldrig tid, materialer eller andet der ikke fremgår direkte.
- Returner KUN valid JSON — ingen forklaring udenfor JSON

Eksempel — FORKERT: udfoert_arbejde indeholder "Skiftet pakning", OG observationer indeholder "Læk under håndvask" — det er det samme problem, bare gentaget!
Eksempel — RIGTIGT: udfoert_arbejde indeholder "Skiftet pakning", observationer er [] — læk er løst, ikke en ny observation.

Transskription: {{transcription}}`

// ─────────────────────────────────────────────────────────────────────────────
// Niche-definitioner
//
// NB: hvert app forventes på sigt at have sin egen "generel"-niche fordi
// konteksten er forskellig (fx AidKick = produktivitet, gæsteliste = events).
// For nu seedes kun echolima/AidKick's varianter. Når gæsteliste-app'en
// bygges, oprettes fx niches/generel_gaesteliste med appIds: ["gaesteliste"]
// og en kontekst-specifik prompt.
// ─────────────────────────────────────────────────────────────────────────────

const niches = [
  {
    id: 'generel',
    displayName: { da: 'Generel', en: 'General' },
    description: {
      da: 'Generisk produktivitetsassistent',
      en: 'Generic productivity assistant'
    },
    prompt: generelPrompt,
    minTier: 'tier_free',
    appIds: ['echolima'],
    isActive: true,
    order: 0,
    version: '1.0'
  },
  {
    id: 'vvs',
    displayName: { da: 'VVS & Håndværker', en: 'Plumber & Craftsman' },
    description: {
      da: 'Strukturerer kundebesøg med udført arbejde, materialer og faktureringsgrundlag',
      en: 'Structures customer visits with work performed, materials, and invoicing basis'
    },
    prompt: vvsPrompt,
    minTier: 'tier_basic',
    appIds: ['echolima'],
    isActive: true,
    order: 1,
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
    console.log(`  ✓ ${niche.id} (minTier: ${niche.minTier}, appIds: ${niche.appIds.join(', ')})`)
  }

  await batch.commit()
  console.log(`\n✅ ${niches.length} niches oprettet/opdateret i Firestore!`)
  process.exit(0)
}

seedNiches().catch(err => {
  console.error('Fejl:', err)
  process.exit(1)
})
