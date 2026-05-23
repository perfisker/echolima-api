# Handoff til Backend Workspace — Niche Capabilities Fase 2
**Fra:** AI Pipeline & MOAT workspace  
**Til:** echolima-api backend workspace  
**Dato:** 22. maj 2026  
**Forudsætning:** Fase 1 er deployed og verificeret (capabilities-schema + telemetry + suffix-support live i prod)

---

## Hvad AI Pipeline workspace har gjort

AI Pipeline workspace har implementeret alle Fase 2-ændringer **direkte i filerne** i dette repo. Det var en fejl i arbejdsgangen — fremadrettet vil AI Pipeline workspace kun levere prompts og anbefalinger til Backend workspace, som så udfører.

De konkrete ændringer der er lavet og ligger klar i koden:

### 1. `src/types/index.ts` — type-union udvidet

`ExtraFieldDef.type` er udvidet med `'object'` (Architecture-WS beslutning 22. maj 2026):

```ts
// FØR:
type: 'string' | 'string[]' | 'object[]' | 'number' | 'boolean'

// EFTER:
type: 'string' | 'string[]' | 'object' | 'object[]' | 'number' | 'boolean'
// 'object'  = nested single object (fx inspektor's parter: { lejer, udlejer })
// 'object[]' = array af nested objects (fx rum[], materialer_brugt[])
```

**Rationale:** inspektor-nichens `parter`-felt er `{ lejer, udlejer }` — et nested objekt, ikke et array. Workaround med `'object[]'` ville være semantisk vildledende.

### 2. `scripts/seedApps.ts` — commonCapabilities populeret

`apps/echolima.commonCapabilities` er nu fyldt med:

**3 voiceCommands:**
| id | action | minTier |
|---|---|---|
| `ai_suggestions` | `rerun_analysis_with_suffix` → suggested_improvements | tier_basic |
| `list_capabilities` | `local_ui` → capability_list | ingen |
| `pii_shield_flag` | `set_metadata_flag` → pii_detected | ingen |

**1 metadataFlag:**
| id | autoDetect | visualHint |
|---|---|---|
| `pii_detected` | true | color: #E54F4F, icon: shield_alert |

**0 extraFields** (alle extraFields er per-niche i V1)

Fremtidige flags er kommenteret ind i filen som dokumentationsforlæg: `retention_30d` og `sensitive_business`.

### 3. `scripts/seedNiches.ts` — per-niche extraFields populeret + versioner bumped

| Niche | Version | extraFields |
|---|---|---|
| `generel` | 1.1.0 → **1.2.0** | 17 entries (union af moede/opgave/beslutning/ide/note) |
| `haandvaerker` | 1.2.0 → **1.3.0** | 13 entries |
| `inspektor` | 1.0.0 → **1.1.0** | 16 entries inkl. `parter` med `type: 'object'` |
| `vvs` | 1.0 (uændret) | ingen (arkiveret, berøres ikke) |

Alle tre aktive niches bruger nu `makeCapabilities(extraFields)` i stedet for tomme arrays. Per-niche `voiceCommands` og `metadataFlags` er tomme i V1 — alle app-globale.

### 4. `src/routes/ai.ts` — PII metadata.flags tilføjet

`applyPiiDetection()` sætter nu `metadata.flags: ['pii_detected']` på response-objektet når PII detekteres. Da både `/ai/analyze` og `/ai/vision` kalder samme funktion, gælder det symmetrisk for begge endpoints:

```ts
if (piiDetected) {
  modelResponse.metadata = modelResponse.metadata ?? {}
  modelResponse.metadata.flags = modelResponse.metadata.flags ?? []
  if (!modelResponse.metadata.flags.includes('pii_detected')) {
    modelResponse.metadata.flags.push('pii_detected')
  }
}
```

**TypeScript-status:** `npx tsc --noEmit` er rent efter alle ændringer.

---

## Hvad Backend workspace skal gøre nu

### Trin 1 — Review ændringerne

```bash
git diff HEAD
```

Bekræft at de 4 filer ser korrekte ud:
- `src/types/index.ts` — type-union udvidet med `'object'`
- `scripts/seedApps.ts` — commonCapabilities populeret med 3 voiceCommands + 1 metadataFlag
- `scripts/seedNiches.ts` — extraFields populeret, versioner bumped
- `src/routes/ai.ts` — metadata.flags sat i applyPiiDetection()

### Trin 2 — TypeScript-check

```bash
npx tsc --noEmit
```

Forventet: ingen output (rent).

### Trin 3 — Commit og deploy

```bash
git add src/types/index.ts scripts/seedApps.ts scripts/seedNiches.ts src/routes/ai.ts
git commit -m "Niche Capabilities Fase 2: population af voice commands + extraFields + PII metadata-flags"
git push origin main
```

Render auto-deployer efter push (~2 min).

### Trin 4 — Seed Firestore (efter Render-deploy)

Kør i denne rækkefølge:

```bash
npm run seed:apps     # opdaterer apps/echolima med voiceCommands + metadataFlags
npm run seed:niches   # opdaterer generel + haandvaerker + inspektor med extraFields
```

**Vigtigt:** `seed:apps` skal køre **før** Android begynder at teste — men seed:niches kan køre parallelt.

### Trin 5 — Verificér i prod

```bash
# Test GET /niches returnerer populerede capabilities
curl https://echolima-api.onrender.com/niches?appId=echolima \
  -H "Authorization: Bearer <token>" | jq '{
    voiceCommands: .commonCapabilities.voiceCommands | length,
    metadataFlags: .commonCapabilities.metadataFlags | length,
    generelFields: .niches[0].capabilities.extraFields | length,
    haandvaerkerFields: .niches[1].capabilities.extraFields | length,
    inspektorFields: .niches[2].capabilities.extraFields | length
  }'
```

**Forventet output:**
```json
{
  "voiceCommands": 3,
  "metadataFlags": 1,
  "generelFields": 17,
  "haandvaerkerFields": 13,
  "inspektorFields": 16
}
```

```bash
# Test PII metadata.flags — send transskription med CPR-nummer
curl -X POST https://echolima-api.onrender.com/ai/analyze \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"transcription": "Kunden hedder Anders Nielsen, CPR 010190-1234", "nicheId": "generel"}' \
  | jq '{piiDetected: .piiDetected, flags: .metadata.flags}'
```

**Forventet output:**
```json
{
  "piiDetected": true,
  "flags": ["pii_detected"]
}
```

```bash
# Test rerun_analysis_with_suffix returnerer KUN specified fields
curl -X POST https://echolima-api.onrender.com/ai/analyze \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "transcription": "Vi skal have styr på projektet inden næste uge",
    "nicheId": "generel",
    "suffix": "Generer 3 kreative forslag.",
    "fieldsToOverwrite": ["suggested_improvements"]
  }' | jq 'keys'
```

**Forventet output:** `["suggested_improvements"]` — kun ét felt.

---

## Hvad der IKKE er gjort (bevidste udskydelser)

- **Per-niche voiceCommands** (fx "tilføj rum" for inspektor, "marker som faktureret" for haandvaerker) — Fase 3, kan prioriteres uafhængigt
- **Capabilities hot-swap** uden app-restart — V2, kræver Android push notifications
- **Telemetri-dashboard** over capability adoption — kan bygges oven på eksisterende `/admin/niche-stats`

---

## Koordination med Android workspace

Når deploy er verificeret, er Android-laget klar til at bygge:

1. **Voice Command Engine** — 3 reelle triggers at registrere og dispatche
2. **Dynamic Field Renderer** — extraFields-deklarationer for alle 3 aktive niches
3. **PII-badge** — `metadata.flags: ['pii_detected']` er nu eksponeret i alle AI-responses

Send signal til Android workspace når seed:niches er kørt og GET /niches returnerer korrekte counts.
