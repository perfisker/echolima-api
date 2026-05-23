# Backend-spec: Niche-arkitektur til AidKick MOAT

> **Fra:** AI Pipeline workspace  
> **Til:** echolima-api workspace  
> **Dato:** 17. maj 2026  
> **Prioritet:** Høj — forudsætning for MOAT-launch

---

## Kopiér dette som workspace-prompt

> Jeg arbejder videre på **echolima-api** (Node + TypeScript + Express, hosted på Render.com).
> Backend-filen der er relevant er primært `src/routes/ai.ts` (332 linjer) samt `src/routes/auth.ts`, `src/middleware/auth.ts` og `src/types/index.ts`.
>
> Vi skal implementere **niche-specifik AI-pipeline** — AidKick's konkurrencefordel (MOAT). Opgaven er beskrevet nedenfor som en samlet spec. Implementér ét step ad gangen og verificér inden næste.
>
> Hold dig til de filer der er nævnt — Android-app og Cloud Functions ændres ikke i denne session.

---

## Kontekst

AidKick's `POST /ai/analyze` returnerer i dag altid det samme generiske output (`title`, `summary`, `tasks`) uanset om brugeren er VVS'er, ejendomsmægler eller sælger. Vi har designet og valideret niche-specifikke prompts i et separat AI lab-workspace. Nu skal de implementeres i backend.

Arkitekturen bygger på fire principper:
- **Prompts lever i Firestore**, ikke i koden — så vi kan forbedre dem uden deploy
- **Niches er app-tilknyttede** via `appIds`-felt — én niche kan bruges i flere apps (1-til-mange), men vises kun i de relevante
- **Brugeren sætter sin default-niche i profilen** (under indstillinger i appen)
- **Niche-brug logges** så vi ved hvilke niches der faktisk bruges i praksis

### Hvorfor ikke et separat Firebase-projekt?

Niches er placeret i samme Firebase-projekt som brugerdata (`echolima-769c7`). App-segregering løses med `appIds: string[]` på niche-dokumentet — præcis samme mønster som `users/{uid}/usage/{appId}` allerede bruger. Et separat projekt ville kræve dobbelt Admin SDK-credentials og cross-project latency uden reel gevinst. Notér til fremtiden: hvis niches skal eksponeres til **eksterne** tredjeparts-apps, kan de flyttes til eget projekt — men det er ikke tilfældet for AidKick + gæsteliste-app.

---

## Step 1 — Firestore: `niches`-collection

Opret en ny root-level collection `niches/{nicheId}` i Firestore.

### Schema

```typescript
interface NicheDoc {
  id: string                    // fx "vvs", "ejendomsmaegler", "saelger", "generel"
  displayName: { da: string; en: string }
  description: { da: string; en: string }
  prompt: string                // Den fulde prompt-tekst med {{transcription}} placeholder
  minTier: string               // "tier_free" | "tier_basic" | "tier_pro"
  appIds: string[]              // Hvilke apps niches er tilgængelig i — fx ["echolima"] eller ["echolima", "gaesteliste"]
  isActive: boolean
  order: number                 // Til UI-sortering inden for en given app
  version: string               // fx "1.0" — til sporbarhed
  createdAt: FirebaseFirestore.Timestamp
  updatedAt: FirebaseFirestore.Timestamp
}
```

**1-til-mange relation:** Én niche kan tilknyttes flere apps ved at tilføje app-ID'et til `appIds`-arrayet. En niche med `appIds: ["echolima"]` vises aldrig i gæsteliste-appen og omvendt. Nye app-tilknytninger kræver ingen kode-ændringer — kun en Firestore-opdatering.

```typescript
// Eksempel på fremtidig gæsteliste-niche der ikke må vises i AidKick:
niches/event_koordinator
  appIds: ["gaesteliste"]
  displayName: { da: "Event-koordinator" }
  ...
```
```

### Seed-script: `scripts/seedNiches.ts`

Opret script svarende til `scripts/seedTiers.ts`. Det skal seede disse dokumenter:

**`niches/generel`**
```
displayName: { da: "Generel", en: "General" }
description: { da: "Generisk produktivitetsassistent", en: "Generic productivity assistant" }
minTier: "tier_free"
appIds: ["echolima"]
isActive: true
order: 0
version: "1.0"
prompt: [den eksisterende analyzePrompt-tekst fra ai.ts — med {{transcription}} placeholder]
```

**`niches/vvs`**
```
displayName: { da: "VVS & Håndværker", en: "Plumber & Craftsman" }
description: { da: "Strukturerer kundebesøg med udført arbejde, materialer og faktureringsgrundlag", en: "..." }
minTier: "tier_basic"
appIds: ["echolima"]
isActive: true
order: 1
version: "1.0"
prompt: [se nedenfor under "VVS-prompt"]
```

### VVS-prompt til Firestore (indsæt som `prompt`-felt)

```
Du er en assistent for VVS-installatører og håndværkere i Danmark.

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

Transskription: {{transcription}}
```

---

## Step 2 — Backend: Niche-cache i `ai.ts`

Tilføj in-memory cache for niches svarende til tier-cachen i `tiers.ts`.

```typescript
// Øverst i ai.ts — efter eksisterende imports
const nicheCache = new Map<string, { prompt: string; fetchedAt: number }>()
const NICHE_CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutter

async function getNichePrompt(nicheId: string): Promise<string | null> {
  const cached = nicheCache.get(nicheId)
  if (cached && Date.now() - cached.fetchedAt < NICHE_CACHE_TTL_MS) {
    return cached.prompt
  }
  const doc = await db.collection('niches').doc(nicheId).get()
  if (!doc.exists) return null
  const data = doc.data() as { prompt: string; isActive: boolean }
  if (!data.isActive) return null

  // Husk at importere db fra firebase-admin øverst i filen
  nicheCache.set(nicheId, { prompt: data.prompt, fetchedAt: Date.now() })
  return data.prompt
}
```

**Bemærk:** `db` skal importeres fra Firebase Admin — se hvordan `tiers.ts` eller `auth.ts` importerer det og brug samme mønster.

---

## Step 3 — Modificér `POST /ai/analyze`

### Ny request-body

```typescript
// Før:
const { transcription } = req.body

// Efter:
const { transcription, nicheId } = req.body
// nicheId er optional — default til "generel" hvis ikke sendt
```

### Ny prompt-logik

```typescript
// Hent niche-prompt fra Firestore (med cache-fallback)
let promptText: string

if (nicheId && nicheId !== 'generel') {
  // Tjek at brugeren har adgang til denne niche (tier-check)
  const userTier = req.user?.tierId ?? 'tier_free'
  const nicheDoc = await db.collection('niches').doc(nicheId).get()

  if (nicheDoc.exists) {
    const niche = nicheDoc.data() as NicheDoc
    const tierOrder = ['tier_free', 'tier_basic', 'tier_pro', 'tier_unlimited']
    const userTierIndex = tierOrder.indexOf(userTier)
    const minTierIndex = tierOrder.indexOf(niche.minTier)

    if (userTierIndex >= minTierIndex) {
      // Brugeren har adgang — hent cachet prompt
      const nichePrompt = await getNichePrompt(nicheId)
      promptText = nichePrompt
        ? nichePrompt.replace('{{transcription}}', transcription)
        : analyzePrompt(transcription) // fallback
    } else {
      // Brugeren har ikke adgang til denne niche
      return res.status(403).json({
        error: 'niche_tier_required',
        message: `Denne niche kræver ${niche.displayName.da}-abonnement eller højere`
      })
    }
  } else {
    // Ukendt niche — brug generel
    promptText = analyzePrompt(transcription)
  }
} else {
  promptText = analyzePrompt(transcription)
}
```

### Fuld fallback-strategi

```
nicheId sendt? → NEJ  → brug analyzePrompt() (eksisterende)
              → JA   → hent fra Firestore-cache
                      → ikke fundet? → brug analyzePrompt() + log advarsel
                      → tier utilstrækkelig? → returner 403
                      → isActive = false? → brug analyzePrompt()
```

---

## Step 4 — Nyt endpoint: `GET /niches`

Returnerer alle aktive niches tilgængelige for brugerens tier og app. Android bruger dette til at populere dropdown i indstillinger.

```
GET /niches?appId=echolima
Authorization: Bearer <token>
→ { niches: [{ id, displayName, description, minTier, order }] }
```

Filtrer på:
1. `isActive: true`
2. `appIds array-contains appId` (query-parameter, default `"echolima"`)
3. `minTier` ≤ brugerens tier

Sortér på `order`-felt. Returnér **ikke** `prompt`-feltet — det er backend-only IP.

**Bemærk:** `prompt`-feltet må IKKE returneres til klienten — det er backend-only IP.

---

## Step 5 — `defaultNiche` på brugerprofil

### Firestore

Tilføj `defaultNiche: string` (default `"generel"`) til `users/{uid}`-dokumentet. Sættes ved `/auth/sync` hvis feltet ikke allerede er sat.

### `PATCH /auth/me`

`defaultNiche` tilføjes som tilladt felt i PATCH-handleren (svarende til `locale` og `displayName`). Validér at værdien er en eksisterende aktiv niche-ID.

### Android-note (til koordination)

Android skal sende `defaultNiche` fra brugerens profil med i `/ai/analyze`-kaldet som `nicheId`-parameter. Brugeren sætter sin default under Indstillinger → Sprog & præferencer. Feltet hentes fra `UserProfile` som allerede synkroniseres via `/auth/me`.

---

## Step 6 — Niche-usage logging

### Formål

Vi vil vide hvilke niches der bruges mest i praksis — både globalt (admin-dashboard) og per bruger.

### Implementation

Udvid den eksisterende `events`-collection med et `nicheId`-felt. Det eksisterende `/usage/record`-kald der allerede logges for `aiSummary`-events skal blot have `nicheId` tilføjet:

```typescript
// I /ai/analyze, efter succesfuldt OpenAI-kald — tilføj nicheId til event-log
await db.collection('events').add({
  uid: req.user.uid,
  appId: 'echolima',
  type: 'aiSummary',
  nicheId: nicheId ?? 'generel',      // ← nyt felt
  timestamp: FieldValue.serverTimestamp(),
  tokens: completion.usage?.total_tokens ?? 0,
  costUsd: (completion.usage?.total_tokens ?? 0) * 0.00000015 // gpt-4o-mini pris
})
```

### Nyt admin-endpoint: `GET /admin/niche-stats`

```
GET /admin/niche-stats
Authorization: Bearer <admin-token>
→ {
    period: "all-time",
    stats: [
      { nicheId: "vvs", displayName: "VVS & Håndværker", count: 142, pct: 38 },
      { nicheId: "generel", displayName: "Generel", count: 118, pct: 32 },
      ...
    ],
    total: 374
  }
```

Implementeres ved at gruppere `events`-collection på `nicheId`-feltet. Brug Firestore's `collectionGroup`-query eller aggregér i Node.

---

## Ny endpoint-oversigt (efter implementation)

```
GET  /niches                              → { niches: [...] }        (kræver auth)
GET  /admin/niche-stats                   → { stats: [...] }         (kræver admin)

POST /ai/analyze   { transcription, nicheId? }  → NoteAnalysisResponse
POST /ai/vision    { transcription, nicheId? }  → NoteAnalysisResponse  (fase 2)
PATCH /auth/me     { defaultNiche? }            → { updated }
```

---

## Nye typer til `src/types/index.ts`

```typescript
export interface NicheDoc {
  id: string
  displayName: { da: string; en: string }
  description: { da: string; en: string }
  prompt: string
  minTier: string
  isActive: boolean
  order: number
  version: string
  createdAt: FirebaseFirestore.Timestamp
  updatedAt: FirebaseFirestore.Timestamp
}

export interface NichePublic {
  id: string
  displayName: { da: string; en: string }
  description: { da: string; en: string }
  minTier: string
  order: number
}
```

---

## Step 7 — Vision + niche-prompts

`POST /ai/vision` skal bruge samme niche-prompt-logik som `/ai/analyze`. Forskellen er at prompten får et vision-suffix injiceret når billeder er vedhæftet.

### Opdatér `getNichePrompt()` med vision-flag

```typescript
async function getNichePrompt(nicheId: string, withVision = false): Promise<string | null> {
  const prompt = await getCachedPrompt(nicheId)
  if (!prompt) return null

  if (withVision) {
    return prompt + `\n\nEt eller flere billeder er vedlagt.
- Inkorporér relevante visuelle detaljer i din analyse (fx opmålinger, skader, produktmærker)
- Tilføj feltet "imageTranscription" som et array — ét element per billede med al synlig tekst, eller null hvis billedet ikke indeholder tekst
- Returner array selv ved ét billede: ["tekst fra billede 1"]`
  }
  return prompt
}
```

### Modificér `POST /ai/vision`

Samme `nicheId`-parameter og tier-check som `/ai/analyze`. Kald `getNichePrompt(nicheId, true)` i stedet for den hardcodede `visionPrompt()`.

### Ændring i response

`imageTranscription` ændres fra `string | null` til `string[] | null` — ét element per billede. Backward-compat: Android-versioner der ikke kender array-formatet vil ignorere feltet indtil app'en opdateres.

---

## Step 8 — Multi-billede support

**Scope:** Backend-kontrakten designes til flere billeder fra dag ét, selv om Android-implementeringen af multi-billede UI er en separat Android-sprint.

### Backend (`ai.ts`)

```typescript
// Skift fra single til array — max 10 billeder
upload.array('images', 10)

// Byg content-array til GPT-4o dynamisk
const imageContents = (req.files as Express.Multer.File[]).map(file => ({
  type: 'image_url' as const,
  image_url: {
    url: `data:${file.mimetype};base64,${file.buffer.toString('base64')}`,
    detail: 'low' as const
  }
}))

const completion = await callWithRetry(() =>
  openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: promptText },
        ...imageContents          // 1–10 billeder
      ]
    }],
    max_tokens: 1500 + (imageContents.length * 200), // mere plads ved flere billeder
    response_format: { type: 'json_object' }
  })
)
```

### `imageTranscription` — array per billede

GPT-4o returnerer tekst-ekstraktion for **alle** billeder samlet i ét array:

```json
"imageTranscription": [
  "Faktura nr. 4821, dato 15/5, beløb 3.200 kr",
  "Opmåling: 2,4m × 1,8m = 4,32m²",
  null
]
```

Tredje element er `null` fordi billedet ikke indeholdt synlig tekst. Antallet af elementer matcher antallet af indsendte billeder.

### Firebase Storage — ny sti-struktur

```
I dag (ét billede):
  images/{uid}/{noteId}.jpg

Fremover (flere billeder):
  images/{uid}/{noteId}/0.jpg
  images/{uid}/{noteId}/1.jpg
  images/{uid}/{noteId}/2.jpg
```

**Bemærk til Android-workspace:** Room `Note`-entiteten skal migreres fra ét `imagePath`-felt til en liste. Det kræver Room v13-migration og er en dedikeret Android-sprint.

### Backward-compat for eksisterende enkelt-billede kald

Hvis Android sender ét billede via det gamle `image`-felt (i stedet for `images[]`), håndteres det med et middleware-shim:

```typescript
// Acceptér både gammelt 'image' og nyt 'images[]' felt
const files = req.files?.length
  ? req.files as Express.Multer.File[]
  : req.file ? [req.file] : []
```

---

## Ny endpoint-oversigt (efter alle 8 steps)

```
GET  /niches?appId=echolima              → { niches: [...] }
GET  /admin/niche-stats                  → { stats: [...] }

POST /ai/analyze   { transcription, nicheId? }
                   → NoteAnalysisResponse (niche-struktureret)

POST /ai/vision    multipart: images[] (1-10), body.transcription, body.nicheId?
                   → NoteAnalysisResponse + imageTranscription: string[]

PATCH /auth/me     { defaultNiche? }     → { updated }
```

---

## Test-checkliste

- [ ] `npx ts-node scripts/seedNiches.ts` kører uden fejl og opretter docs i Firestore
- [ ] `GET /niches?appId=echolima` returnerer generel + vvs for tier_basic-bruger, kun generel for tier_free
- [ ] `GET /niches?appId=gaesteliste` returnerer kun niches med `appIds` der indeholder `"gaesteliste"`
- [ ] `POST /ai/analyze` med `nicheId: "vvs"` bruger VVS-prompt (verificér via forskelligt output-format)
- [ ] `POST /ai/analyze` med `nicheId: "vvs"` for tier_free-bruger returnerer 403
- [ ] `POST /ai/analyze` uden `nicheId` stadig virker som før (backward-compat)
- [ ] `PATCH /auth/me` med `defaultNiche: "vvs"` gemmer feltet på user-doc
- [ ] Events i Firestore har `nicheId`-felt efter analyze-kald
- [ ] `GET /admin/niche-stats` returnerer korrekt fordeling
- [ ] Niche-cache fungerer — andet kald til samme niche rammer ikke Firestore igen
- [ ] `POST /ai/vision` med `nicheId: "vvs"` returnerer VVS-struktureret output + `imageTranscription[]`
- [ ] `POST /ai/vision` med 3 billeder returnerer `imageTranscription` array med 3 elementer
- [ ] `POST /ai/vision` med gammelt enkelt `image`-felt stadig virker (backward-compat shim)

---

## Rækkefølge for implementation

1. `scripts/seedNiches.ts` + kør seeder
2. `getNichePrompt()` cache-funktion med vision-flag i `ai.ts`
3. Modificér `POST /ai/analyze` med `nicheId`-parameter
4. Modificér `POST /ai/vision` med `nicheId` + multi-billede + `imageTranscription[]`
5. `GET /niches`-endpoint i ny fil `routes/niches.ts`
6. `defaultNiche` på `PATCH /auth/me`
7. Niche-logging på events + `/admin/niche-stats`

---

## Hvad dette workspace IKKE skal gøre

- Android UI-ændringer (niche-dropdown, multi-billede flow) — dedikeret Android-sprint
- Room v13-migration til liste af image-paths — Android-sprint
- Ændringer i Cloud Functions (Storage-triggers opdateres til ny sti-struktur i separat sprint)
- Nye Stripe-produkter eller tier-priser

---

## Niche Capabilities — Fase 1 (implementeret 22. maj 2026)

Arkitektur-beslutninger: se `EchoLima_Niche_Capabilities_Architecture.md`

### Hvad der er implementeret

**TypeScript-typer** (`src/types/index.ts`):
- `ExtraFieldDef`, `VoiceCommandDef`, `MetadataFlagDef`, `Capabilities` — capabilities-schema
- `AppDoc` — apps/{appId} Firestore-doc med `commonCapabilities`
- `NichePublic` udvidet med `capabilities?: Capabilities`
- `NichesResponse` — ny response-shape med `commonCapabilities` + `niches[]`
- `NicheDoc` udvidet med `capabilities?: Capabilities`

**seedNiches.ts** (version bump):
- `generel`: `1.0` → `1.1.0` (capabilities-schema tilføjet, tomme arrays)
- `haandvaerker`: `1.1.0` → `1.2.0` (capabilities-schema tilføjet, tomme arrays)
- `vvs` (legacy): uændret

**seedApps.ts** (ny fil):
- Opretter `apps/echolima` med `commonCapabilities: { extraFields: [], voiceCommands: [], metadataFlags: [] }`
- Brug: `npm run seed:apps`
- `merge: true` — skriver ikke over eksisterende felter (bundleId, platform, version)

**GET /niches** (`src/routes/niches.ts`):
- Henter nu `apps/{appId}` parallelt med users/{uid} (én Firestore round-trip)
- Returnerer `NichesResponse` med `commonCapabilities` + `niches[]`
- Hvert niche-element inkluderer `capabilities` hvis det er til stede
- Backward-compat: gamle klienter der læser kun `.niches[]` fortsætter uberørt

**Telemetry** (`src/routes/telemetry.ts`, mountet på `/telemetry`):
- `POST /telemetry/capability_invoked` — capability aktiveret succesfuldt
- `POST /telemetry/capability_failed` — capability sprunget over (reason valideres)
- `POST /telemetry/capability_listed` — bruger åbnede "hvad kan jeg sige"-skærm
- Alle events skrives til Firestore `events`-collection

**rerun_analysis_with_suffix** (`src/routes/ai.ts`):
- `POST /ai/analyze` accepts nu optional `suffix: string` og `fieldsToOverwrite: string[]`
- suffix appendes til den endelige prompt (efter PII + ANALYSIS_SUFFIX)
- Når `fieldsToOverwrite` er specificeret returneres kun de navngivne felter fra ny analyse
- Event-type `aiSummaryRerun` logges separat fra `aiSummary` for cost-tracking

### Brug af rerun_analysis_with_suffix (eksempel)

```json
POST /ai/analyze
{
  "transcription": "...",
  "nicheId": "haandvaerker",
  "suffix": "Foreslå yderligere kreative løsninger og forebyggende vedligehold kunden kan overveje.",
  "fieldsToOverwrite": ["suggested_improvements"]
}
```

Response: kun `{ "suggested_improvements": ["...", "..."] }` — klienten merger ind i eksisterende note.

### Næste skridt (Fase 2)

1. Fyld `haandvaerker.capabilities.extraFields` med felter der matcher niche-JSON-output:
   - `kunde`, `udfoert_arbejde`, `materialer_brugt`, `observationer`, `bestillinger`, `faktureringsgrundlag`
2. Tilføj app-globale voice commands til `apps/echolima.commonCapabilities.voiceCommands`:
   - `ai_suggestions` → `rerun_analysis_with_suffix`
   - `show_capabilities` → `local_ui: show_capability_list`
   - `pii_shield` → `set_metadata_flag: pii_detected`
3. Android implementerer Dynamic Field Renderer + Voice Command Engine (se arkitektur-doc §8)
4. Bump niche `version`-felt pr. capabilities-ændring (Android cacher pr. version)
