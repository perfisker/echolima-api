# HUB-opdatering — 22. maj 2026

> **Formål:** To nye sektioner klar til indsættelse i EchoLima_HUB.md  
> **§6a** indsættes efter §6 (Datamodel)  
> **§25** indsættes efter §24 (Sprint-leverancer)  
> Arkitektur-beslutningerne bag dette refereres i `EchoLima_Niche_Capabilities_Architecture.md`

---

## §6a — Niche-system og Capabilities (MOAT)

### Hvad er niches?

Niches er per-vertical AI-prompts der giver specifikke faggrupper et markant bedre output end den generiske analysemodel. I stedet for at returnere den samme `{ title, summary, tasks }`-struktur for alle brugere, returnerer en niche-prompt et feltformat der matcher brugerens fag præcist.

Niches er EchoLima's primære konkurrencefordel (MOAT) — det er svært for generiske produkter at kopiere vertikal fagekspertise indlejret i veldesignede prompts.

### Hvor lever niches?

Niche-prompts lever i Firestore (`niches/{nicheId}`) og hentes ved runtime af `/ai/analyze` og `/ai/vision`. De caches i-memory på backend med 5 minutters TTL. Det betyder prompts kan forbedres og deployes uden kode-deploy — kun et Firestore-update er nødvendigt.

### Aktive niches pr. 22. maj 2026

| id | Visningsnavn | minTier | Beskrivelse |
|---|---|---|---|
| `generel` | Generel | tier_free | Adaptiv type-klassifikation (møde / opgave / beslutning / idé / note) |
| `haandvaerker` | Håndværker | tier_basic | VVS, elektriker, murer, tømrer — struktureret besøgsrapport med faktureringsgrundlag |
| `inspektor` | Inspektør | tier_basic | Fraflytning, indflytning, byggeplads, tilstandsrapport — rum-for-rum observations-struktur |
| `vvs` | VVS (arkiveret) | — | **Arkiveret 20. maj 2026.** Erstattet af `haandvaerker`. Bevaret i Firestore for klient-cache-kompatibilitet. |

### Prompt-format og output

Alle niche-prompts bruger `{{transcription}}`-placeholder der substitueres med brugerens transskription ved runtime.

**generel** returnerer adaptivt JSON baseret på detekteret type:
```
moede      → { type, title, summary, deltagere[], beslutninger[], tasks[], open_questions[], naeste_moede }
opgave     → { type, title, summary, tasks[], open_questions[] }
beslutning → { type, title, summary, beslutning, begrundelse, alternativer_fravalgt[], konsekvenser[], tasks[], open_questions[] }
ide        → { type, title, summary, ide_beskrivelse, fordele[], udfordringer[], tasks[], open_questions[] }
note       → { type, title, summary, tasks[], open_questions[] }
```

**haandvaerker** returnerer:
```
{ type: "haandvaerker_visit", title, kunde, transporttid_timer, udfoert_arbejde[], materialer_brugt[],
  observationer[], bestillinger[], naeste_besoeg, faktureringsgrundlag, tasks[] }
```

**inspektor** returnerer adaptivt JSON baseret på detekteret inspektionstype:
```
fraflytning → { type, title, objekt, dato, parter{lejer,udlejer}, rum[], generelle_observationer[],
                samlet_estimat, naeste_skridt[], konklusion, tasks[] }
indflytning → { type, title, objekt, dato, parter{lejer,udlejer}, rum[], generelle_observationer[],
                naeste_skridt[], konklusion, tasks[] }
byggeplads  → { type, title, objekt, dato, fremdrift, rum[], sikkerhedsfund[], generelle_observationer[],
                bestillinger[], naeste_skridt[], konklusion, tasks[] }
tilstand    → { type, title, objekt, dato, rum[] (med K-klassifikation pr. observation),
                generelle_observationer[], naeste_skridt[], konklusion, tasks[] }
```

Alle niches appender desuden universal addendum (`ANALYSIS_SUFFIX` + `PII_DETECTION_SUFFIX`) der tilføjer:
```
suggested_improvements[], gaps[], follow_up_questions[], piiDetected, piiTypes[]
```

### Backward-compat

Android bruger Gson der ignorerer ukendte JSON-felter stille. Niche-specifikke ekstrafelter vises ikke i ældre app-versioner — de fungerer blot ikke. Ingen breaking changes.

### Capabilities-system (Fase 1 live, Fase 2 klar)

Hvert niche-dokument har et `capabilities`-felt der deklarerer ekstrafelter, voice commands og metadata-flags til Android-klientens Dynamic Field Renderer og Voice Command Engine.

**Fase 1 (deployed 22. maj 2026):** Arkitektur og tomme skabeloner live. `apps/echolima` oprettet med `commonCapabilities`. GET /niches returnerer `NichesResponse` med `commonCapabilities` + per-niche `capabilities`.

**Fase 2 (klar, afventer Android Voice Command Engine):** Population af faktiske extraFields, voice commands og metadata-flags. Detaljeret handover-prompt ligger i `ai-pipeline/ai_pipeline_fase2_capabilities_population_prompt.md`.

Se `EchoLima_Niche_Capabilities_Architecture.md` for fulde arkitektur-beslutninger.

### Tilføjelse af ny niche — standardproces

1. Design og valider prompt i `ai-pipeline/03_prompt_bibliotek/` (brug OpenAI Playground + evalPrompt.ts)
2. Tilføj niche-objekt til `scripts/seedNiches.ts` med `capabilities: emptyCapabilities`
3. Kør `npm run seed:niches`
4. Tilføj 5 sample-transskriptioner til `scripts/evalPrompt.ts` og kør `--niche=X --score`
5. Krav: ≥11/15 i eval-score på realistiske samples = produktionsklar

---

## §25 — Niche Capabilities — Arkitektur-runde (17.–22. maj 2026)

### Baggrund

I perioden 17.–22. maj 2026 designede og implementerede EchoLima et capabilities-system der giver Android-klienten mulighed for dynamisk at tilpasse sin renderer og voice engine baseret på hvilken niche brugeren har valgt — uden APK-update.

### Otte arkitektur-beslutninger

De fulde beslutninger med rationale er dokumenteret i `EchoLima_Niche_Capabilities_Architecture.md`. Kort resumé:

| Spørgsmål | Beslutning |
|---|---|
| Source of truth | **Prompt is king** (V1). Capabilities er klient-metadata, ikke prompt-generator. |
| Granularitet | **Hybrid**: app-globale `commonCapabilities` + per-niche `capabilities`. Merge med niche-override. |
| Action-typer V1 | **3 typer:** `rerun_analysis_with_suffix`, `set_metadata_flag`, `local_ui` |
| Tier-gating | **To-niveau:** optional `minTier` på niche + på individual capability |
| Lokalisering | `{ da: string; en?: string }` på alle tekster. V1 kun dansk. |
| Discovery | **Udvidet GET /niches** returnerer `NichesResponse` med `commonCapabilities` + `niches[]` |
| Backward-compat | **Silent skip + telemetry** + optional `minClientVersion` pr. capability |
| Prompt-injection | **Nej i V1.** Voice commands er post-recording triggers — ikke pre-recording context. |

### Hvad der er implementeret

**Backend (echolima-api):**
- `src/types/index.ts`: `ExtraFieldDef`, `VoiceCommandDef`, `MetadataFlagDef`, `Capabilities`, `AppDoc`, `NichesResponse`
- `src/routes/niches.ts`: returnerer `NichesResponse` med `commonCapabilities` fra `apps/{appId}`
- `src/routes/telemetry.ts`: `POST /telemetry/capability_invoked|failed|listed`
- `src/routes/ai.ts`: `POST /ai/analyze` med `suffix` + `fieldsToOverwrite` for `rerun_analysis_with_suffix`
- `scripts/seedApps.ts`: seeder `apps/echolima` med tomme capabilities
- `scripts/seedNiches.ts`: alle aktive niches har `capabilities: emptyCapabilities`

**Niches i prod:**
- `generel` v1.1.0, `haandvaerker` v1.2.0, `inspektor` v1.0.0

**AI Pipeline (MOAT):**
- Eval-metodologi etableret: GPT-4o som dommer, 5 samples, 15-point skala, tærskel ≥11
- Prompt-bibliotek: `generel` (14/15), `haandvaerker` (15/15), `inspektor` (13/15)
- `scripts/evalPrompt.ts` understøtter `--niche=vvs|inspektor`

### Næste milepæle

| Milepæl | Status | Forudsætning |
|---|---|---|
| Capabilities Fase 2 — population | ⏳ Klar | Afventer Android Voice Command Engine-sprint |
| Android Dynamic Field Renderer | ⏳ Ikke startet | Fase 2 deployed |
| Android Voice Command Engine | ⏳ Ikke startet | Fase 2 deployed |
| Næste niche (Ejendomsmægler eller Sælger) | ⏳ Backlog | Kan startes uafhængigt |
