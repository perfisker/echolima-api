# Handoff til Backend Workspace — 22. maj 2026

> **Fra:** AI Pipeline & MOAT workspace  
> **Til:** echolima-api backend workspace  
> **Dato:** 22. maj 2026

---

## Hvad er gjort i denne session

### 1. Niche Capabilities — Fase 1 (implementeret i koden)

Alle 7 backend-tasks er implementeret og `tsc --noEmit` er rent:

| Fil | Ændring |
|---|---|
| `src/types/index.ts` | Tilføjet: `ExtraFieldDef`, `VoiceCommandDef`, `MetadataFlagDef`, `Capabilities`, `AppDoc`, `NichesResponse`. `NicheDoc` + `NichePublic` udvidet med `capabilities?: Capabilities` |
| `src/routes/niches.ts` | GET /niches returnerer nu `NichesResponse` med `commonCapabilities` (fra `apps/{appId}`) + `capabilities` på hvert niche-element. Backward-compat. |
| `src/routes/telemetry.ts` | Ny fil. `POST /telemetry/capability_invoked`, `/capability_failed`, `/capability_listed` — skriver til `events`-collection |
| `src/routes/ai.ts` | `POST /ai/analyze` accepts nu `suffix?: string` + `fieldsToOverwrite?: string[]`. Suffix appendes til prompt, partial merge ved fieldsToOverwrite. Event-type `aiSummaryRerun` logges separat. |
| `src/index.ts` | `telemetryRoutes` importeret og mountet på `/telemetry` |
| `scripts/seedNiches.ts` | `generel` → v1.1.0, `haandvaerker` → v1.2.0, `inspektor` tilføjet v1.0.0. Alle aktive niches har `capabilities: emptyCapabilities` |
| `scripts/seedApps.ts` | Ny fil. Opretter `apps/echolima` med `commonCapabilities` (tomme arrays), `merge: true` |
| `package.json` | `"seed:niches"` og `"seed:apps"` tilføjet som npm-scripts |

### 2. Ny niche: Inspektør (prompt designet og valideret)

Prompt: `ai-pipeline/03_prompt_bibliotek/inspektor_analyze_v1.md`

- **4 inspektionstyper:** fraflytning, indflytning, byggeplads, tilstand
- **Rum-for-rum struktur** — hvert rum er et element med egne observationer
- **Type-specifikke ekstrafelter:** `parter` (fraflytning/indflytning), `samlet_estimat` (fraflytning), `fremdrift` + `sikkerhedsfund` (byggeplads), K-klassifikation (tilstand)
- **Eval-score:** 13/15 på realistiske samples (+93% over baseline) — produktionsklar
- Tilføjet til `scripts/seedNiches.ts` (id: `inspektor`, `minTier: tier_basic`, `order: 3`)
- Tilføjet til `scripts/evalPrompt.ts` med 5 samples og inspektør-specifik scoring

### 3. Niche-oversigt efter denne session

| id | Display | minTier | isActive | Version |
|---|---|---|---|---|
| `generel` | Generel | tier_free | ✅ | 1.1.0 |
| `haandvaerker` | Håndværker | tier_basic | ✅ | 1.2.0 |
| `inspektor` | Inspektør | tier_basic | ✅ | 1.0.0 |
| `vvs` | VVS (arkiveret) | tier_basic | ❌ | 1.0 |

---

## Hvad backend workspace skal gøre nu

### Trin 1 — Seed til Firestore (kræver service-account.json)

```bash
npm run seed:apps     # Opretter apps/echolima med commonCapabilities
npm run seed:niches   # Opdaterer generel + haandvaerker, tilføjer inspektor
```

Kør `seed:apps` **før** `seed:niches` — niches-endpoint læser fra apps-collection.

### Trin 2 — Deploy backend til Render

Standard deploy-flow. Ingen breaking changes — alle ændringer er additive.

Android-klienter på gamle versioner:
- Ignorerer `commonCapabilities` stille (Gson ignorerer ukendte felter)
- Ignorerer `capabilities` på hvert niche-element stille
- `POST /ai/analyze` uden `suffix`/`fieldsToOverwrite` opfører sig identisk som før

### Trin 3 — Verificér efter deploy

```
GET /niches?appId=echolima
```

Forventet response-shape:
```json
{
  "commonCapabilities": { "extraFields": [], "voiceCommands": [], "metadataFlags": [] },
  "niches": [
    { "id": "generel", "capabilities": { ... }, ... },
    { "id": "haandvaerker", "capabilities": { ... }, ... },
    { "id": "inspektor", "capabilities": { ... }, ... }
  ]
}
```

Test også at `POST /telemetry/capability_invoked` med `{ nicheId: "inspektor", capabilityId: "test" }` returnerer `{ logged: true }`.

---

## Hvad der IKKE er gjort (bevidste udskydelser)

**Capabilities Fase 2** — udfyldning af faktiske capabilities er ikke gjort. Det tomme skelet er seeded; selve indholdet (extraFields der matcher prompt-output, voice commands) udfyldes i en separat session når Android er klar til at implementere Dynamic Field Renderer og Voice Command Engine.

Se `EchoLima_Niche_Capabilities_Architecture.md` §7 (Fase 2) for detaljer.

---

## Nøglefiler til reference

| Fil | Indhold |
|---|---|
| `ai-pipeline/03_prompt_bibliotek/inspektor_analyze_v1.md` | Inspektør-prompt, evalueringskriterier, versionslog |
| `ai-pipeline/03_prompt_bibliotek/haandvaerker_analyze_v1.md` (i seedNiches) | Håndværker-prompt |
| `ai-pipeline/03_prompt_bibliotek/generel_analyze_v1.md` | Generel adaptiv prompt |
| `ai-pipeline/04_backend_spec_niche_arkitektur.md` | Fuld backend-spec inkl. Capabilities Fase 1 dokumentation |
| `EchoLima_Niche_Capabilities_Architecture.md` | Arkitektur-beslutninger for capabilities-system |
| `scripts/evalPrompt.ts` | Eval-script — `npx ts-node scripts/evalPrompt.ts --niche=inspektor --score` |
