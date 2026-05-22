import { Router, Response } from 'express'
import multer from 'multer'
import OpenAI, { toFile } from 'openai'
import { getFirestore } from 'firebase-admin/firestore'
import { AuthRequest, NicheDoc } from '../types'
import { verifyToken } from '../middleware/auth'

const router = Router()
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 } // 25 MB maks
})

function getOpenAI(): OpenAI {
  const key = process.env.OPENAI_API_KEY
  if (!key) throw new Error('OPENAI_API_KEY er ikke sat')
  return new OpenAI({ apiKey: key })
}

// ─────────────────────────────────────────────────────────────────────────────
// Niche-cache
//
// In-memory cache med 5 min TTL. Cacher HELE NicheDoc'et (ikke kun prompt)
// så caller har adgang til minTier, appIds, isActive, displayName osv. uden
// ekstra Firestore-reads. /ai/analyze bruger både prompt og minTier — derfor
// undgår vi at læse samme doc to gange ved kun at cache prompten.
//
// Cache invalideres automatisk efter 5 min, eller manuelt via clearNicheCache
// (eksponeres til admin-endpoint i routes/admin.ts senere).
// ─────────────────────────────────────────────────────────────────────────────

interface CachedNiche {
  data: NicheDoc
  fetchedAt: number
}

const nicheCache = new Map<string, CachedNiche>()
const NICHE_CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutter

export function clearNicheCache(nicheId?: string): void {
  if (nicheId) {
    nicheCache.delete(nicheId)
  } else {
    nicheCache.clear()
  }
}

/**
 * Henter en niche-doc fra Firestore (med in-memory cache).
 *
 * Returnerer null hvis:
 *  - Niche-doc'et findes ikke
 *  - isActive er false (niche'n er deaktiveret administrativt)
 *
 * Cache-miss laver præcis ét Firestore-read. Efterfølgende kald inden for
 * 5 minutter rammer kun memory.
 */
// ─────────────────────────────────────────────────────────────────────────────
// Legacy niche-aliasing
//
// Når vi renamer en niche (fx vvs → haandvaerker 20. maj 2026), kan ældre
// Android-versioner stadig sende det gamle niche-ID. I stedet for at returnere
// 403 niche_tier_required eller silent falde tilbage til generel, mapper vi
// stille fra det gamle ID til det nye. Klienten oplever ingen ændring; bag
// kulisserne bruger vi den nye niche-prompt.
//
// /auth/sync laver tilsvarende lazy migration på user-docs. Begge dele
// sammen sikrer at brugere på ældre app-versioner får fornuftig AI-output
// og at nye AI-kald gradvist konvergerer til de nye niche-navne.
// ─────────────────────────────────────────────────────────────────────────────

const LEGACY_NICHE_ALIASES: Record<string, string> = {
  vvs: 'haandvaerker'   // Renamed 20. maj 2026
}

function resolveNicheId(nicheId: unknown): string | undefined {
  if (typeof nicheId !== 'string') return undefined
  return LEGACY_NICHE_ALIASES[nicheId] ?? nicheId
}

export async function getNiche(nicheId: string): Promise<NicheDoc | null> {
  const cached = nicheCache.get(nicheId)
  if (cached && Date.now() - cached.fetchedAt < NICHE_CACHE_TTL_MS) {
    return cached.data
  }

  const db = getFirestore()
  const doc = await db.collection('niches').doc(nicheId).get()
  if (!doc.exists) return null

  const data = doc.data() as NicheDoc
  if (!data.isActive) return null

  // doc.id er authoritative — sikrer at .id-feltet i objektet matcher
  // doc-referencen, også selvom seed-scriptet glemte at sætte det.
  data.id = doc.id

  nicheCache.set(nicheId, { data, fetchedAt: Date.now() })
  return data
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier-håndtering for niche-adgangskontrol
//
// req.user (DecodedIdToken fra Firebase Auth) indeholder ikke tierId — det
// er kun JWT-claims. Vi henter tier fra users/{uid}.tierId hver gang.
//
// Bevidst INGEN cache her: tier kan ændres af Stripe-webhooks når som helst,
// og stale tier-data ville lade en netop-degraderet bruger fortsætte med at
// bruge premium-niches. Prisen er ét ekstra Firestore-read per /ai/analyze-
// kald — acceptabelt givet at AI-kald er sjældne (få per minut per bruger)
// og dyre (OpenAI-cost dominerer).
// ─────────────────────────────────────────────────────────────────────────────

const TIER_ORDER = ['tier_free', 'tier_basic', 'tier_pro', 'tier_unlimited']

function tierMeetsMinimum(userTier: string, minTier: string): boolean {
  const userIdx = TIER_ORDER.indexOf(userTier)
  const minIdx = TIER_ORDER.indexOf(minTier)
  if (userIdx === -1 || minIdx === -1) return false
  return userIdx >= minIdx
}

async function getUserTier(uid: string): Promise<string> {
  const db = getFirestore()
  const snap = await db.collection('users').doc(uid).get()
  return snap.data()?.tierId ?? 'tier_free'
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt-byggeri (niche-baseret)
//
// buildPrompt substituerer {{transcription}}-placeholder med brugerens reelle
// transskription, og tilføjer optional vision-suffix når billeder er vedlagt.
// Vision-suffixet instruerer GPT-4o i at returnere imageTranscription som et
// ARRAY (ét element per billede) i stedet for en enkelt string — designet til
// multi-billede support indført i Step 8.
// ─────────────────────────────────────────────────────────────────────────────

const VISION_PROMPT_SUFFIX = `

Et eller flere billeder er vedlagt.
- Inkorporér ALLE billeders indhold (synlig tekst, objekter, måling, observationer, mærker) i "summary" og "tasks" så brugeren får et samlet overblik på tværs af billeder
- Tilføj feltet "imageTranscription" som et array — ét element per billede med opsummering af DET billedes indhold:
  · Hvis billedet indeholder synlig tekst: gengiv teksten (bevar formatering hvor det giver mening)
  · Hvis billedet ikke har tekst: kort visuel beskrivelse (fx "Billede af lækkende rør under håndvask, ca. 22mm dimension")
  · Brug KUN null hvis billedet er helt tomt, ulæseligt eller defekt
- Antallet af elementer i arrayet skal MATCHE antallet af indsendte billeder, i samme rækkefølge
- Returner array selv ved ét billede: ["indhold af billede 1"]`

function buildPrompt(niche: NicheDoc, transcription: string, withVision = false): string {
  let prompt = niche.prompt.replace('{{transcription}}', transcription)
  if (withVision) {
    prompt += VISION_PROMPT_SUFFIX
  }
  return prompt
}

// ─────────────────────────────────────────────────────────────────────────────
// PII (personhenførbar information) detektion
//
// Hybrid approach:
//   1) Regex fanger deterministiske mønstre (CPR, telefon, email, IBAN, kort)
//   2) AI-prompt-addendum beder modellen flagge kontekstuelle PII'er
//      (navne, adresser, fødselsdatoer, helbreds-/finans-info)
//
// Server-side mergeres begge resultater. Defensiv-tilgang: hvis AI'en
// glemmer at tilføje felterne, sikrer regex at vi alligevel fanger åbenlys
// PII. Tilsvarende fanger AI ting regex aldrig kan (sammenhænge, kontekst).
//
// Bruges af /ai/analyze og /ai/vision. Suffix appendes ALTID til den endelige
// prompt (på tværs af niche/fallback-paths), så PII-detektion er konsistent
// for alle bruger-flows.
// ─────────────────────────────────────────────────────────────────────────────

const PII_REGEX_PATTERNS: Array<{ type: string; pattern: RegExp }> = [
  // CPR-nummer: DDMMYY[-]XXXX. Validerer dag 01-31 + måned 01-12 for at
  // undgå at matche tilfældige 10-cifrede tal som ordretal eller årstal.
  { type: 'cpr', pattern: /\b(0[1-9]|[12]\d|3[01])(0[1-9]|1[0-2])\d{2}[-\s]?\d{4}\b/ },
  // Dansk telefon: 8 cifre i grupper af 2, evt. med +45 og mellemrum/bindestreg
  { type: 'phone', pattern: /\b(?:\+45[\s-]?)?\d{2}[\s-]?\d{2}[\s-]?\d{2}[\s-]?\d{2}\b/ },
  // Email
  { type: 'email', pattern: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/ },
  // Dansk IBAN: DK + 2 check-cifre + 18 cifre
  { type: 'iban', pattern: /\bDK\d{2}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{2}\b/i },
  // Kreditkort: 16 cifre i grupper af 4
  { type: 'creditcard', pattern: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/ }
]

function detectPiiInText(text: string): string[] {
  if (!text || typeof text !== 'string') return []
  const detected = new Set<string>()
  for (const { type, pattern } of PII_REGEX_PATTERNS) {
    if (pattern.test(text)) detected.add(type)
  }
  return Array.from(detected)
}

const PII_DETECTION_SUFFIX = `

VIGTIG TILFØJELSE — Tjek for personhenførbare data (PII):
Tilføj følgende felter til din JSON-respons:
- "piiDetected": boolean — true hvis transskriptionen indeholder personhenførbar information om en kunde, klient, kollega eller tredjepart der KAN identificere en specifik person
- "piiTypes": array af detekterede typer fra:
  · "name" — fuldt personnavn (fornavn+efternavn) eller på anden vis identificerende
  · "address" — adresse eller del af adresse (vej, husnummer, by)
  · "birthdate" — fødselsdato eller dato der antyder en specifik persons alder
  · "health" — helbredsoplysninger, diagnoser, medicin, behandling
  · "financial" — finansielle detaljer (kontonumre, gæld, indkomst-niveau, kreditværdighed)

Regler for hvad der IKKE er PII:
- Generiske roller som "kunden", "brugeren", "ham/hende" er ikke PII alene
- Egne kollegers fornavne alene (fx "Anders skal ringe") er ikke PII — det er interne task-ejere
- Firmanavne eller generelle stedreferencer (fx "Brønshøj", "Aalborg") er ikke PII
- Beløb og priser uden personlig kontekst er ikke PII

Hvis transskriptionen ikke indeholder PII: "piiDetected": false, "piiTypes": [].`

function applyPiiDetection(
  modelResponse: Record<string, any>,
  textsToScan: string[]
): Record<string, any> {
  // Regex-detektion på input-tekst (transcription + evt. imageTranscriptions)
  const regexPii = new Set<string>()
  for (const text of textsToScan) {
    detectPiiInText(text).forEach(t => regexPii.add(t))
  }

  // AI-detection fra model-respons (kan være undefined/null hvis model glemte)
  const aiPii: string[] = Array.isArray(modelResponse.piiTypes)
    ? modelResponse.piiTypes.filter((t: unknown) => typeof t === 'string')
    : []

  // Union af begge
  const combined = Array.from(new Set([...aiPii, ...regexPii]))

  // Overskriv altid med konsoliderede værdier — sikrer at felterne ALTID
  // er til stede, også når model glemte dem.
  modelResponse.piiDetected = combined.length > 0
  modelResponse.piiTypes = combined

  return modelResponse
}

// ─────────────────────────────────────────────────────────────────────────────
// Udvidet analyse — universal addendum på tværs af alle niches og typer
//
// ANALYSIS_SUFFIX appendes ALTID efter PII_DETECTION_SUFFIX i den endelige
// prompt. Den beder modellen returnere tre konstruktive ekstra-felter UD OVER
// niche-skemaet:
//
//   suggested_improvements  — konkrete forslag til hvad brugeren kunne gøre bedre
//   gaps                    — information der manglede i optagelsen
//   follow_up_questions     — spørgsmål brugeren bør stille for at lukke noten
//
// Dette gælder for ALLE niches (generel, haandvaerker, fremtidige) og ALLE
// typer (moede, opgave, beslutning, ide, note, haandvaerker_visit). Felterne
// må ikke overlappe med tasks eller open_questions — det er bevidst en
// "AI-bonus" oven på det brugeren selv har talt.
//
// applyAnalysisDefaults() sikrer at de tre felter ALTID er til stede (også
// tomme []) hvis modellen glemmer dem.
// ─────────────────────────────────────────────────────────────────────────────

const ANALYSIS_SUFFIX = `

UDVIDET ANALYSE — Tilføj følgende konstruktive felter til JSON-responsen:

- "suggested_improvements": array af KONKRETE forslag til hvad brugeren kunne gøre bedre eller anbefale kunden/teamet
  · Møde-eksempel: ["Følg op med skriftlig opsummering inden 24 timer"]
  · Håndværker-eksempel: ["Anbefal forebyggende termostat-skift på 2. sal", "Foreslå serviceaftale baseret på alder på installation"]
  · Opgave-eksempel: ["Inkludér deadline når du delegerer", "Tilføj kontekst om hvorfor opgaven haster"]

- "gaps": array af SPECIFIK information der manglede i optagelsen men burde have været med
  · Møde-eksempel: ["Næste skridt blev ikke aftalt", "Beslutningstageren blev ikke identificeret"]
  · Håndværker-eksempel: ["Vandtryk blev ikke målt", "Kundens telefonnummer blev ikke noteret"]
  · Opgave-eksempel: ["Deadline blev ikke nævnt", "Det er uklart hvem der ejer opgaven"]

- "follow_up_questions": array af KONSTRUKTIVE spørgsmål brugeren bør stille kunde/team/sig selv for at lukke noten
  · Møde-eksempel: ["Hvad er kundens deadline for beslutning?", "Hvem skal kontakte leverandøren?"]
  · Håndværker-eksempel: ["Skal vi planlægge eftersyn til foråret?", "Vil kunden have en samlet pris eller specificeret faktura?"]
  · Opgave-eksempel: ["Er der eksisterende ressourcer at trække på?", "Hvad er konsekvensen ved forsinkelse?"]

Regler:
- Forslag/gaps/spørgsmål skal være KONKRETE og handlingsorienterede — undgå generiske platituder ("husk at være grundig" er FORKERT)
- Felterne må IKKE gentage noget der allerede står i "tasks" eller "open_questions"
- Maks 3-5 elementer per felt — kvalitet over kvantitet
- Hvis intet relevant: returner tom array []
- Returner ALTID alle tre felter (også tomme) så klient kan rendere konsistent

Bemærk: disse tre felter er en AI-værdi-tilføjelse oven på det brugeren talte — ikke et sammendrag. Vær opfindsom inden for faget.`

function applyAnalysisDefaults(modelResponse: Record<string, any>): Record<string, any> {
  // Sikrer at felterne ALTID er til stede som arrays (selv hvis model glemte
  // eller returnerede null/undefined). Type-safe filtering så vi ikke render
  // ikke-strings i klient-UI.
  const ensureStringArray = (val: unknown): string[] =>
    Array.isArray(val) ? val.filter((s): s is string => typeof s === 'string') : []

  modelResponse.suggested_improvements = ensureStringArray(modelResponse.suggested_improvements)
  modelResponse.gaps = ensureStringArray(modelResponse.gaps)
  modelResponse.follow_up_questions = ensureStringArray(modelResponse.follow_up_questions)

  return modelResponse
}

// ─────────────────────────────────────────────────────────────────────────────
// Retry-logik til OpenAI rate limits
//
// Ved 429 (rate limit) venter vi eksponentielt og prøver igen.
// Andre fejl kastes videre med det samme — ingen grund til at prøve igen.
// Forsøg: 0 → vent 1s → forsøg 1 → vent 2s → forsøg 2 → vent 4s → kast fejl
// ─────────────────────────────────────────────────────────────────────────────

async function callWithRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3
): Promise<T> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn()
    } catch (err: any) {
      const isRateLimit =
        err?.status === 429 ||
        err?.message?.toLowerCase().includes('rate limit') ||
        err?.message?.toLowerCase().includes('too many requests')

      // Kast fejlen videre hvis det ikke er rate limit, eller vi har brugt alle forsøg
      if (!isRateLimit || attempt === maxRetries - 1) throw err

      const delayMs = Math.pow(2, attempt) * 1000  // 1s, 2s, 4s
      console.warn(`OpenAI rate limit — venter ${delayMs}ms (forsøg ${attempt + 1}/${maxRetries})`)
      await new Promise(resolve => setTimeout(resolve, delayMs))
    }
  }
  throw new Error('Max retries exceeded')
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompts
// ─────────────────────────────────────────────────────────────────────────────

function analyzePrompt(transcription: string): string {
  return `Du er en professionel assistent der hjælper med at strukturere talenoter. Du fungerer som projektleder, referent og produktejer på samme tid.

Læs transskriptionen og afgør hvilken TYPE den tilhører:
- "moede"      → møde, diskussion, referat, opfølgning med andre
- "opgave"     → konkret task, reminder, to-do, ting der skal gøres
- "beslutning" → en beslutning der er taget eller skal tages
- "ide"        → idé, brainstorm, koncepttanke, "hvad hvis"-scenarie
- "note"       → alt andet: observation, tanke, info, freeform

Returner KUN JSON i det format der matcher typen — se nedenfor. Skriv på dansk. Udfyld kun felter der er nævnt i transskriptionen.

════════════════════════════════
TYPE: moede
════════════════════════════════
{
  "type": "moede",
  "title": "Kort mødebeskrivelse (max 8 ord)",
  "summary": "Hvad mødet handlede om og hvad der blev nået (2-3 sætninger)",
  "deltagere": ["Navne nævnt i transskriptionen — [] hvis ingen nævnt"],
  "beslutninger": ["Konkrete beslutninger taget i mødet"],
  "tasks": [
    { "handling": "Hvad skal gøres", "ejer": "Navn hvis nævnt — ellers null", "deadline": "Deadline hvis nævnt — ellers null" }
  ],
  "open_questions": ["Spørgsmål eller emner der ikke blev afklaret"],
  "naeste_moede": "Tidspunkt for næste møde hvis nævnt — ellers null"
}

════════════════════════════════
TYPE: opgave
════════════════════════════════
{
  "type": "opgave",
  "title": "Kort opgavebeskrivelse (max 8 ord)",
  "summary": "Kort kontekst for opgaven hvis relevant — ellers null",
  "tasks": [
    { "handling": "Hvad skal gøres", "prioritet": "hast eller normal — brug 'hast' kun hvis det eksplicit nævnes", "deadline": "Deadline hvis nævnt — ellers null", "ejer": "Navn hvis nævnt — ellers null" }
  ],
  "open_questions": ["Åbne spørgsmål eller uafklarede afhængigheder — [] hvis ingen"]
}

════════════════════════════════
TYPE: beslutning
════════════════════════════════
{
  "type": "beslutning",
  "title": "Kort beslutningsbeskrivelse (max 8 ord)",
  "summary": "Kontekst og baggrund for beslutningen (1-2 sætninger)",
  "beslutning": "Den konkrete beslutning der er taget",
  "begrundelse": "Hvorfor denne beslutning — hvis nævnt, ellers null",
  "alternativer_fravalgt": ["Andre muligheder der blev overvejet men fravalgt — [] hvis ingen nævnt"],
  "konsekvenser": ["Hvad beslutningen betyder fremadrettet — [] hvis ikke nævnt"],
  "tasks": ["Handlinger der følger af beslutningen"],
  "open_questions": ["Åbne spørgsmål eller uafklarede afhængigheder — [] hvis ingen"]
}

════════════════════════════════
TYPE: ide
════════════════════════════════
{
  "type": "ide",
  "title": "Kort idébeskrivelse (max 8 ord)",
  "summary": "Idéen i et nøddeskal (1-2 sætninger)",
  "ide_beskrivelse": "Uddybende beskrivelse af idéen som dikteret",
  "fordele": ["Potentielle fordele nævnt — [] hvis ingen"],
  "udfordringer": ["Potentielle udfordringer nævnt — [] hvis ingen"],
  "tasks": ["Næste skridt for at undersøge eller realisere idéen"],
  "open_questions": ["Åbne spørgsmål eller uafklarede afhængigheder — [] hvis ingen"]
}

════════════════════════════════
TYPE: note (fallback)
════════════════════════════════
{
  "type": "note",
  "title": "Kort beskrivelse (max 8 ord)",
  "summary": "Hvad notaten handler om (2-3 sætninger)",
  "tasks": ["Konkrete handlinger hvis nævnt — [] hvis ingen"],
  "open_questions": ["Åbne spørgsmål eller uafklarede afhængigheder — [] hvis ingen"]
}

Regler:
- Vælg KUN én type — den der passer bedst
- Inkludér ALTID title, summary, tasks og open_questions (selvom de er [])
- Ekstraher ALLE konkrete handlinger der nævnes i transskriptionen — vær udtømmende og inkluderende. Det er bedre at have én task for meget end at glemme én.
- Opfind aldrig information der ikke er nævnt i transskriptionen
- Returner KUN valid JSON — ingen tekst udenfor JSON

Hvad tæller som en task (vær eksplicit og udtømmende — ekstraher ALT):
- Direkte instruktioner: "skal kontakte X", "ring til Y", "bestil Z", "send mail til W"
- Implicitte handlinger: "vi mangler at høre fra X" → task: "Følg op med X"
- Aftaler indgået med andre: "Jens skulle sende dokumenterne" → task: "Modtag dokumenter fra Jens"
- Egne handlinger: "jeg skal...", "jeg vil...", "jeg må huske at..."
- Husk-ting: "huske at X", "ikke glemme at Y", "vigtigt at få gjort Z"
- Forberedelser: "skal læse op på X inden mødet", "skal forberede Y"
- Opfølgning: "tjekke ind med X", "følge op på Y", "spørge Z om W"
- Beslutninger der kræver handling: "vi vælger A" → hvis A kræver setup eller implementering, lav task
- Næste skridt nævnt eksplicit: "næste skridt er...", "som det næste skal vi..."
Hvad tæller IKKE som en task:
- Ting der allerede er udført: "jeg har sendt mailen", "vi har besluttet at..."
- Generelle observationer uden handling: "det var en god dag", "X var interessant"
- Hypotetiske scenarier uden commitment: "vi kunne måske..." (medmindre der følger en konkret aftale)

Hvad tæller som et åbent spørgsmål (open_questions):
- Eksplicitte spørgsmål: "hvad koster det?", "hvem tager sig af X?"
- Udtrykt usikkerhed: "jeg ved ikke om...", "det er uklart om..."
- Uafklarede afhængigheder: "det afhænger af Y", "vi afventer svar fra Z"
- Ting der skal undersøges: "vi skal finde ud af...", "mangler at tjekke..."
Hvad tæller IKKE: ting der allerede er besvaret i samme transskription

Distinktion task vs. open_question:
- Hvis det kan handles direkte → task
- Hvis det kræver svar/afklaring fra anden side → open_question
- Hvis det er begge dele → læg i tasks med formuleringen "Få afklaret X med Y"

Transskription: ${transcription}`
}

function visionPrompt(transcription: string): string {
  return `Du er en produktivitetsassistent. Du får et billede og en transskription fra en talenotat.
Analyser begge og returner JSON med:
1. En kort sigende titel (max 6 ord)
2. Et kort resume der kombinerer hvad der ses på billedet og hvad der siges (2-3 sætninger)
3. En liste af konkrete opgaver/handlinger baseret på begge inputs
4. En præcis transskription af AL tekst der er synlig i billedet (bevar original formatering og rækkefølge)
Returner KUN dette JSON format:
{
    "title": "...",
    "summary": "...",
    "tasks": ["opgave 1", "opgave 2"],
    "imageTranscription": "al tekst fra billedet her, eller null hvis ingen tekst"
}
Transskription: ${transcription}`
}

function parseVoiceCommandPrompt(contactList: string, taskList: string): string {
  return `Du er en assistent der parser stemmekommandoer til at sende noter via email.
Tilgængelige kontakter: ${contactList}
Tilgængelige opgaver:
${taskList}
Returner KUN JSON med disse felter:
- contactNames: liste af kontaktnavne at sende til
- includeResume: om resumé/opsummering skal med (default true)
- includeTranscription: om lydtekst/transskription/optagelse skal med (brugeren siger "lydtekst")
- taskIndices: liste af opgavenumre (1-baseret) der skal med
- includeAllTasks: om alle opgaver skal med (brugeren siger "opgaver" eller "alle opgaver")
- includeImage: om billede skal vedhæftes
- includeImageText: om billedtekst/tekst fra billede skal med (brugeren siger "billedtekst")
Eksempel 1: "send resumé og opgave 1 og 3 til Michael"
Svar: {"contactNames":["Michael"],"includeResume":true,"includeTranscription":false,"taskIndices":[1,3],"includeAllTasks":false,"includeImage":false,"includeImageText":false}
Eksempel 2: "send lydtekst og billedtekst og alle opgaver til Sarah"
Svar: {"contactNames":["Sarah"],"includeResume":false,"includeTranscription":true,"taskIndices":[],"includeAllTasks":true,"includeImage":false,"includeImageText":true}`
}

function parseAlarmPrompt(now: string): string {
  return `Du er en assistent der udtrækker dato og tid fra dansk tekst.
Returner KUN en ISO datetime string på formatet "YYYY-MM-DDTHH:mm:ss", eller ordet null hvis du ikke kan tolke datoen.

Regler for manglende information:
- Hvis intet år nævnes: brug indeværende år fra "Nu er"-linjen nedenfor.
- Hvis ingen måned nævnes: brug indeværende måned fra "Nu er"-linjen nedenfor.
- Hvis intet klokkeslet nævnes: sæt klokkeslet til 13:00:00.
- Relativt datouttryk som "i morgen", "om to dage", "næste mandag" beregnes ud fra dags dato.

Eksempler (antag at i dag er 2026-05-04T10:30:00):
- "husk mig på fredag"           → "2026-05-08T13:00:00"
- "alarm i morgen kl 9"          → "2026-05-05T09:00:00"
- "påmind mig den 15. kl 14.30"  → "2026-05-15T14:30:00"
- "sæt alarm til den 3. juni"    → "2026-06-03T13:00:00"
- "husk mig om en uge"           → "2026-05-11T13:00:00"
- "alarm næste mandag kl 8"      → "2026-05-11T08:00:00"

Nu er: ${now}`
}

// ─────────────────────────────────────────────────────────────────────────────
// Endpoints
// ─────────────────────────────────────────────────────────────────────────────

// POST /ai/transcribe
// Multipart: field "file" (audio/m4a eller audio/*)
router.post('/transcribe', verifyToken, upload.single('file'), async (req: AuthRequest, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'Ingen lydfil vedhæftet' })
      return
    }
    const uid = req.user!.uid
    const fileSize = req.file.size
    const openai = getOpenAI()
    const audioFile = await toFile(req.file.buffer, req.file.originalname ?? 'audio.m4a', {
      type: req.file.mimetype ?? 'audio/m4a'
    })
    const transcription = await callWithRetry(() =>
      openai.audio.transcriptions.create({
        file: audioFile,
        model: 'whisper-1',
        language: 'da'
      })
    )

    // Event-logging — fanger transcription-events til /admin/cost-rapportering.
    // Whisper koster $0.006/minut audio. Vi kan ikke nemt udlede minutter fra
    // request, så vi bruger filstørrelse som proxy. AAC 128kbps ≈ 1 MB/min,
    // så bytes/1_048_576 ≈ minutter. Rough estimate; admin-dashboard kan
    // efterjustere hvis vi senere fanger faktisk varighed fra audio-headers.
    try {
      const db = getFirestore()
      const estimatedMinutes = fileSize / (1024 * 1024)
      await db.collection('events').add({
        uid,
        appId: 'echolima',
        type: 'transcription',
        timestamp: Date.now(),
        tokens: 0,                                  // whisper er ikke token-baseret
        costUsd: estimatedMinutes * 0.006,          // Whisper: $0.006/min
        audioBytes: fileSize
      })
    } catch (logErr) {
      console.error('ai/transcribe event-log fejl (response sendes alligevel):', logErr)
    }

    res.json({ text: transcription.text })
  } catch (err) {
    console.error('ai/transcribe fejl:', err)
    res.status(500).json({ error: 'Transskription fejlede' })
  }
})

// POST /ai/analyze
// Body: { transcription: string, nicheId?: string, suffix?: string, fieldsToOverwrite?: string[] }
// Returns: { title, summary, tasks, ... }  (shape afhænger af niche-prompt)
//
// Niche-håndtering:
//   - nicheId mangler eller === 'generel' → bruger den indbyggede analyzePrompt()
//     (backward-compat for klienter der endnu ikke kender niches)
//   - nicheId === aktiv niche → tier-check + brug niche.prompt med
//     {{transcription}}-substitution
//   - nicheId === ukendt eller deaktiveret niche → fall back til analyzePrompt()
//     og log advarsel (silent degradation, ikke 404)
//   - nicheId === aktiv niche men bruger har for lavt tier → 403 med
//     stable error-kode 'niche_tier_required'
//
// rerun_analysis_with_suffix (Capabilities V1 action-type):
//   - suffix: string → appendes til den endelige prompt (efter PII + ANALYSIS_SUFFIX)
//   - fieldsToOverwrite: string[] → kun disse JSON-felter overskrives med ny analyse.
//     Hvis fieldsToOverwrite er tomt eller mangler, returneres hele ny analyse.
//   - Formål: voice command som "AI-forslag" kan bede backend køre en ekstra
//     analyse med kreative forslag uden at erstatte den primære analyse.
//
// Event-logging: aiSummary-events skrives HER (ikke i /usage/record) så
// vi kan fange nicheId. /usage/record håndterer kun counter-increment for
// aiSummary — se hybrid-arbejdsdeling i routes/usage.ts.
router.post('/analyze', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const { transcription, nicheId: rawNicheId, suffix, fieldsToOverwrite } = req.body
    if (!transcription || typeof transcription !== 'string') {
      res.status(400).json({ error: 'Mangler transskription i body' })
      return
    }

    const uid = req.user!.uid

    // Legacy-alias-mapping: vvs → haandvaerker (20. maj 2026 rename).
    // Sker stille; klienten ved ikke at vi har skiftet niche-ID under huden.
    const nicheId = resolveNicheId(rawNicheId)

    // Bestem effektiv prompt + niche-id til event-logging.
    let promptText: string
    let resolvedNicheId: string = 'generel'

    if (typeof nicheId === 'string' && nicheId !== 'generel') {
      const niche = await getNiche(nicheId)
      if (niche === null) {
        // Ukendt eller deaktiveret niche — silent fall back.
        console.warn(`ai/analyze: niche '${nicheId}' findes ikke eller er deaktiveret — falder tilbage til generel`)
        promptText = analyzePrompt(transcription)
      } else {
        const userTier = await getUserTier(uid)
        if (!tierMeetsMinimum(userTier, niche.minTier)) {
          res.status(403).json({
            error: 'niche_tier_required',
            message: `Denne niche kræver ${niche.displayName.da}-abonnement eller højere`
          })
          return
        }
        promptText = buildPrompt(niche, transcription, false)
        resolvedNicheId = nicheId
      }
    } else {
      promptText = analyzePrompt(transcription)
    }

    // PII-detektion + udvidet analyse gælder uanset niche-path. Appendes
    // ALTID til den endelige prompt så GPT-4o-mini producerer piiDetected/
    // piiTypes/suggested_improvements/gaps/follow_up_questions sammen med
    // det niche-specifikke skema.
    promptText += PII_DETECTION_SUFFIX
    promptText += ANALYSIS_SUFFIX

    // rerun_analysis_with_suffix — Capabilities V1 action-type.
    // Suffix appendes EFTER PII + ANALYSIS_SUFFIX så det kan overskrive eller
    // tilføje til den samlede instruktion. Typisk bruges det til kreative
    // forslag, ekstra analyse-vinkler eller specifik uddybning.
    const hasSuffix = typeof suffix === 'string' && suffix.trim().length > 0
    if (hasSuffix) {
      promptText += `\n\n${suffix.trim()}`
    }

    const openai = getOpenAI()
    const completion = await callWithRetry(() =>
      openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: promptText }],
        max_tokens: 800,
        response_format: { type: 'json_object' }
      })
    )
    const content = completion.choices[0].message.content ?? '{}'
    let parsed: Record<string, any>
    try {
      parsed = JSON.parse(content)
    } catch {
      parsed = {}
    }

    // Hybrid PII: merge AI-detected types med regex-detected types.
    // Regex fanger CPR/telefon/email/IBAN/kreditkort selv hvis model
    // glemmer at flagge dem; AI fanger kontekstuelle ting regex ikke kan.
    parsed = applyPiiDetection(parsed, [transcription])

    // Sikrer at suggested_improvements / gaps / follow_up_questions ALTID
    // er til stede som arrays (også tomme) for konsistent klient-rendering.
    parsed = applyAnalysisDefaults(parsed)

    // fieldsToOverwrite-merge: når suffix er til stede og klienten kun vil
    // have specifikke felter opdateret (fx kun "suggested_improvements"),
    // returnerer vi et objekt med kun de specificerede felter fra den nye
    // analyse. Klienten merger dette ind i sin eksisterende note-state.
    //
    // Eksempel: voice command "AI-forslag" sender:
    //   suffix: "Foreslå yderligere kreative vinkler...",
    //   fieldsToOverwrite: ["suggested_improvements"]
    // Response: { suggested_improvements: ["...", "..."] }
    //
    // Hvis fieldsToOverwrite er tom/mangler returneres hele parsed-objektet
    // (standard analyse-flow eller fuld rerun).
    if (hasSuffix && Array.isArray(fieldsToOverwrite) && fieldsToOverwrite.length > 0) {
      const partial: Record<string, any> = {}
      for (const field of fieldsToOverwrite) {
        if (typeof field === 'string' && field in parsed) {
          partial[field] = parsed[field]
        }
      }
      // Event-logging for suffix-rerun
      try {
        const db = getFirestore()
        const totalTokens = completion.usage?.total_tokens ?? 0
        await db.collection('events').add({
          uid,
          appId: 'echolima',
          type: 'aiSummaryRerun',
          nicheId: resolvedNicheId,
          fieldsToOverwrite,
          timestamp: Date.now(),
          tokens: totalTokens,
          costUsd: totalTokens * 0.000000375
        })
      } catch (logErr) {
        console.error('ai/analyze rerun event-log fejl (response sendes alligevel):', logErr)
      }
      res.json(partial)
      return
    }

    // Event-logging — fang nicheId så /admin/niche-stats kan aggregere.
    // Wrappet i try/catch så event-skrivefejl ikke vælter den legitime
    // AI-response. Brugeren har allerede betalt for OpenAI-kaldet.
    try {
      const db = getFirestore()
      const totalTokens = completion.usage?.total_tokens ?? 0
      await db.collection('events').add({
        uid,
        appId: 'echolima',
        type: 'aiSummary',
        nicheId: resolvedNicheId,
        timestamp: Date.now(),
        tokens: totalTokens,
        piiDetected: parsed.piiDetected === true,
        // gpt-4o-mini approx cost: input $0.150/1M tokens, output $0.600/1M.
        // Vi har ikke input/output-split fra usage-objektet, så vi bruger
        // et blandet gennemsnit på $0.000000375/token. Justér når præcis
        // cost-tracking kræves.
        costUsd: totalTokens * 0.000000375
      })
    } catch (logErr) {
      console.error('ai/analyze event-log fejl (response sendes alligevel):', logErr)
    }

    res.json(parsed)
  } catch (err) {
    console.error('ai/analyze fejl:', err)
    res.status(500).json({ error: 'Analyse fejlede' })
  }
})

// POST /ai/vision
// Multipart fields:
//   - "images" (image/*, 1-10 stk) — nyt felt til multi-billede support
//   - "image" (image/*, 1 stk) — legacy felt, accepteres for backward-compat
//   - body.transcription (text)
//   - body.nicheId (text, optional) — defaulter til 'generel'
//
// Returns: niche-struktureret JSON + imageTranscription: string[] | null
//          (array har samme længde som antal indsendte billeder)
//
// upload.fields() accepterer begge felt-navne i samme request. Klienter
// kan migrere fra single 'image' til multi 'images' uden koordineret deploy.
router.post(
  '/vision',
  verifyToken,
  upload.fields([
    { name: 'image', maxCount: 1 },     // legacy
    { name: 'images', maxCount: 10 }    // multi-billede
  ]),
  async (req: AuthRequest, res: Response) => {
    try {
      // Backward-compat shim: kombinér begge felter til ét files-array.
      // Hvis klient sender begge (sjældent), tager vi alle med — multer
      // har allerede maxCount-grænser per felt.
      const filesObj = (req.files ?? {}) as Record<string, Express.Multer.File[]>
      const files = [...(filesObj.image ?? []), ...(filesObj.images ?? [])]

      if (files.length === 0) {
        res.status(400).json({ error: 'Intet billede vedhæftet' })
        return
      }

      const transcription = (req.body.transcription as string) ?? ''
      const rawNicheId = req.body.nicheId as string | undefined
      const uid = req.user!.uid

      // Legacy-alias-mapping: vvs → haandvaerker (20. maj 2026 rename).
      const nicheId = resolveNicheId(rawNicheId)

      // Niche-resolution: default til 'generel' hvis ikke specificeret.
      // Modsat /ai/analyze (hvor generel = legacy analyzePrompt) bruger /ai/vision
      // ALTID en niche fra Firestore + vision-suffix — det er den eneste måde
      // GPT-4o får besked om at returnere imageTranscription som array.
      const effectiveNicheId = (typeof nicheId === 'string' && nicheId.length > 0)
        ? nicheId
        : 'generel'

      const niche = await getNiche(effectiveNicheId)

      let promptText: string
      if (niche === null) {
        // Niche findes ikke eller er deaktiveret → emergency-fallback til
        // legacy visionPrompt. Bemærk: dette returnerer imageTranscription
        // som single string, IKKE array. Bør være ekstremt sjælden situation
        // (kun hvis 'generel' selv mangler i Firestore).
        console.warn(`ai/vision: niche '${effectiveNicheId}' findes ikke eller er deaktiveret — bruger legacy visionPrompt`)
        promptText = visionPrompt(transcription)
      } else {
        // Tier-check skippes for 'generel' (alle har adgang). For andre niches
        // returnerer vi 403 hvis brugerens tier er utilstrækkeligt.
        if (effectiveNicheId !== 'generel') {
          const userTier = await getUserTier(uid)
          if (!tierMeetsMinimum(userTier, niche.minTier)) {
            res.status(403).json({
              error: 'niche_tier_required',
              message: `Denne niche kræver ${niche.displayName.da}-abonnement eller højere`
            })
            return
          }
        }
        promptText = buildPrompt(niche, transcription, true)
      }

      // PII-detektion + udvidet analyse ALTID — appendes uanset om vi
      // bruger niche- eller emergency-fallback-prompten.
      promptText += PII_DETECTION_SUFFIX
      promptText += ANALYSIS_SUFFIX

      // Byg dynamisk content-array til GPT-4o med ét image_url-element per
      // billede. detail: 'low' holder cost nede (~85 tokens per image)
      // versus 'high' (~170-2000 tokens per image afhængigt af dimensioner).
      const imageContents = files.map(file => ({
        type: 'image_url' as const,
        image_url: {
          url: `data:${file.mimetype ?? 'image/jpeg'};base64,${file.buffer.toString('base64')}`,
          detail: 'low' as const
        }
      }))

      // max_tokens skalerer med billed-antal fordi imageTranscription-array
      // også vokser. Base 1500 (samme som single-image før) + 200 per ekstra
      // billede til ekstra transskription.
      const maxTokens = 1500 + (files.length * 200)

      const openai = getOpenAI()
      const completion = await callWithRetry(() =>
        openai.chat.completions.create({
          model: 'gpt-4o',
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: promptText },
              ...imageContents
            ]
          }],
          max_tokens: maxTokens,
          response_format: { type: 'json_object' }
        })
      )
      const content = completion.choices[0].message.content ?? '{}'
      let parsed: Record<string, any>
      try {
        parsed = JSON.parse(content)
      } catch {
        parsed = {}
      }

      // Hybrid PII: scan transcription + imageTranscription[]-entries med
      // regex. GPT-4o kan udlæse tekst fra billeder, så CPR/telefonnumre
      // synligt på fx en faktura skal også fanges.
      const imageTexts: string[] = Array.isArray(parsed.imageTranscription)
        ? parsed.imageTranscription.filter((t: unknown): t is string => typeof t === 'string')
        : []
      parsed = applyPiiDetection(parsed, [transcription, ...imageTexts])

      // Sikrer at suggested_improvements / gaps / follow_up_questions ALTID
      // er til stede som arrays (også tomme) for konsistent klient-rendering.
      parsed = applyAnalysisDefaults(parsed)

      // Event-logging — fanger visionCall-events til /admin/cost og
      // /admin/niche-stats. Inkluderer både nicheId (til stats) og imageCount
      // (til granular cost-analyse).
      // gpt-4o pris: input $2.50/1M + output $10/1M ≈ blandet $6.25/1M = $0.00000625/token
      try {
        const db = getFirestore()
        const totalTokens = completion.usage?.total_tokens ?? 0
        await db.collection('events').add({
          uid,
          appId: 'echolima',
          type: 'visionCall',
          nicheId: effectiveNicheId,
          timestamp: Date.now(),
          tokens: totalTokens,
          imageCount: files.length,
          piiDetected: parsed.piiDetected === true,
          costUsd: totalTokens * 0.00000625
        })
      } catch (logErr) {
        console.error('ai/vision event-log fejl (response sendes alligevel):', logErr)
      }

      res.json(parsed)
    } catch (err) {
      console.error('ai/vision fejl:', err)
      res.status(500).json({ error: 'Vision-analyse fejlede' })
    }
  }
)

// POST /ai/parse-command
// Body: { spokenText, contactNames, tasks }
// Returns: VoiceCommandResult JSON
router.post('/parse-command', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const { spokenText, contactNames = [], tasks = [] } = req.body
    if (!spokenText) {
      res.status(400).json({ error: 'Mangler spokenText' })
      return
    }
    const openai = getOpenAI()
    const taskList = (tasks as string[]).map((t, i) => `${i + 1}. ${t}`).join('\n')
    const contactList = (contactNames as string[]).join(', ')

    const completion = await callWithRetry(() =>
      openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: parseVoiceCommandPrompt(contactList, taskList) },
          { role: 'user', content: spokenText }
        ],
        max_tokens: 200,
        response_format: { type: 'json_object' }
      })
    )
    const content = completion.choices[0].message.content ?? '{}'
    res.json(JSON.parse(content))
  } catch (err) {
    console.error('ai/parse-command fejl:', err)
    res.status(500).json({ error: 'Kommandoparsing fejlede' })
  }
})

// POST /ai/parse-alarm
// Body: { spokenText, utcOffsetMinutes }
// Returns: { epochMs: number | null }
router.post('/parse-alarm', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const { spokenText, utcOffsetMinutes } = req.body
    if (!spokenText) {
      res.status(400).json({ error: 'Mangler spokenText' })
      return
    }
    const offsetMins = typeof utcOffsetMinutes === 'number' ? utcOffsetMinutes : 0
    const sign = offsetMins >= 0 ? '+' : '-'
    const absMin = Math.abs(offsetMins)
    const tzSuffix = `${sign}${String(Math.floor(absMin / 60)).padStart(2, '0')}:${String(absMin % 60).padStart(2, '0')}`
    const localNow = new Date(Date.now() + offsetMins * 60_000)
    const now = localNow.toISOString().slice(0, 16).replace('T', ' ')

    const openai = getOpenAI()
    const completion = await callWithRetry(() =>
      openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: parseAlarmPrompt(now) },
          { role: 'user', content: `Tekst: "${spokenText}"` }
        ],
        max_tokens: 50
      })
    )
    const content = (completion.choices[0].message.content ?? '').trim()
    if (content === 'null' || !content) {
      res.json({ epochMs: null })
      return
    }
    const dateWithTz = `${content}${tzSuffix}`
    const date = new Date(dateWithTz)
    res.json({ epochMs: isNaN(date.getTime()) ? null : date.getTime() })
  } catch (err) {
    console.error('ai/parse-alarm fejl:', err)
    res.status(500).json({ error: 'Alarmtolkning fejlede' })
  }
})

// POST /ai/parse-contact
// Body: { spokenText: string }
// Returns: { name: string, email: string | null }
router.post('/parse-contact', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const { spokenText } = req.body
    if (!spokenText || typeof spokenText !== 'string') {
      res.status(400).json({ error: 'Mangler spokenText' })
      return
    }
    const openai = getOpenAI()
    const completion = await callWithRetry(() =>
      openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'Udtræk navn og email-adresse fra tekst. Returner KUN JSON på formen {"name":"...","email":"..."} — brug null for email hvis den ikke nævnes. Navn må ikke være null.'
          },
          { role: 'user', content: spokenText }
        ],
        response_format: { type: 'json_object' },
        max_tokens: 100
      })
    )
    const result = JSON.parse(completion.choices[0].message.content ?? '{}')
    res.json({ name: result.name ?? '', email: result.email ?? null })
  } catch (err) {
    console.error('ai/parse-contact fejl:', err)
    res.status(500).json({ error: 'Kontaktparsing fejlede' })
  }
})

export default router