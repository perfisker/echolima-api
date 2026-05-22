# AidKick — Baseline-evaluering (Deliverable #2)

> **Workspace:** EchoLima AI Pipeline & MOAT  
> **Dato:** 17. maj 2026  
> **Formål:** Dokumentere hvad den nuværende generiske `analyzePrompt` producerer for niche-transskriptioner — og præcist hvad der mangler

---

## Den nuværende prompt (fra `src/routes/ai.ts`)

```typescript
function analyzePrompt(transcription: string): string {
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
```

**Model:** `gpt-4o-mini` via `POST /ai/analyze`  
**Output-format:** `{ title, summary, tasks[] }`

---

## Evalueringsmetode

For hver niche:
1. Vi præsenterer en realistisk sample-transskription (som en dansk professionel faktisk ville diktere)
2. Vi simulerer det forventede output fra `analyzePrompt` (baseret på prompt-analyse — GPT-4o-mini er god til dette format)
3. Vi beskriver det **ideelle** niche-specifikke output
4. Vi identificerer **gap-kategorier**

---

## Sample #1: VVS-installatør

**Transskription:**
> "Okay jeg er færdig hos Thomsens, Søndergade 14. Badeværelset stuen — der er et læk under håndvasken, det er pakningerne i sifon-koblingen der er møre. Jeg har skiftet dem, tog 20 minutter. Brugte to pakninger fra bilen, 22 millimeter. Varmt vandsystemet oppe på 1. sal er okay, ingen tryk-problemer. Men jeg lagde mærke til at termostaten på radiatoren i gangen er stiv, kunden spurgte om vi kan kigge på det næste gang. Og husk at bestille nye 22 millimeter pakninger til bilen, vi er ved at løbe tør."

**Forventet output fra generisk `analyzePrompt`:**
```json
{
  "title": "VVS-service hos Thomsens",
  "summary": "Udført VVS-service hos Thomsens på Søndergade 14. Læk under håndvask i badeværelset er udbedret ved udskiftning af pakninger. Varmsystemet på 1. sal fungerer korrekt.",
  "tasks": [
    "Kontrollér termostat på radiator i gangen ved næste besøg",
    "Bestil nye 22 mm pakninger til bilen"
  ]
}
```

**Ideelt niche-specifikt output:**
```json
{
  "title": "Thomsens, Søndergade 14 — service",
  "kunde": "Thomsens, Søndergade 14",
  "udfoert_arbejde": [
    { "opgave": "Sifon-pakning skiftet under håndvask, badeværelse stuen", "tid_min": 20 }
  ],
  "materialer_brugt": [
    { "vare": "Pakning 22mm", "antal": 2, "kilde": "bil-lager" }
  ],
  "observationer": [
    "Radiatortermostat i gang er stiv — kunden ønsker eftersyn næste besøg",
    "Varmt vand 1. sal: OK, intet trykproblem"
  ],
  "bestillinger": [
    "Pakninger 22mm — genopfyld bil-lager (ved at løbe tør)"
  ],
  "naeste_besoeg": "Tjek radiatortermostat, gang",
  "faktureringsgrundlag": "20 min arbejde + 2 stk. pakning 22mm"
}
```

**Gap-analyse:**

| Kategori | Generisk output | Mangler |
|---|---|---|
| Kunde/adresse-struktur | ✅ nævnt i titel | ❌ ikke som struktureret felt |
| Udført arbejde | ⚠️ i resumé, ustruktureret | ❌ ingen tidsregistrering |
| Materialer brugt | ❌ ikke nævnt | ❌ mangler helt |
| Observationer (ikke udført) | ⚠️ som task, blandet med handlinger | ❌ ikke adskilt fra faktisk arbejde |
| Faktureringsgrundlag | ❌ ikke nævnt | ❌ mangler helt |
| Bestillinger/lager | ✅ som task | ✅ dette klarer generisk fint |

**Gap-score: 4/6 kategorier mangler eller er utilstrækkelige**

---

## Sample #2: Ejendomsmægler

**Transskription:**
> "Fremvisning afsluttet, Kastanievej 8, Randers. To par, det ene par — ham hedder Rasmus, hende hedder Stine — de var meget interesserede, spurgte til skoledistriktet og om kælderen kan indrettes. De vil gerne have en 2. fremvisning med Stines forældre lørdag. Det andet par virkede ikke specielt interesserede, gik hurtigt igennem. Ejendommen er fin, men køkkenet er fra 98, det vil sikkert blive brugt som prispres. Husk at sende dem energimærket og BBR-udskriften inden fredag."

**Forventet output fra generisk `analyzePrompt`:**
```json
{
  "title": "Fremvisning Kastanievej 8 Randers",
  "summary": "Gennemført fremvisning af ejendom på Kastanievej 8 i Randers med to interessentpar. Det ene par, Rasmus og Stine, viste stor interesse og ønsker en opfølgende fremvisning med Stines forældre lørdag. Det andet par virkede uinteresserede.",
  "tasks": [
    "Book 2. fremvisning for Rasmus og Stine med Stines forældre lørdag",
    "Send energimærket og BBR-udskrift inden fredag"
  ]
}
```

**Ideelt niche-specifikt output:**
```json
{
  "title": "Fremvisning — Kastanievej 8, Randers",
  "ejendom": "Kastanievej 8, Randers",
  "fremvisningsdato": "[dato for optagelsen]",
  "interessenter": [
    {
      "navn": "Rasmus + Stine",
      "niveau": "Høj interesse",
      "noter": "Spurgte til skoledistrikt og kælder-indretning",
      "naeste_skridt": "2. fremvisning lørdag med Stines forældre — bekræft dato"
    },
    {
      "navn": "Par 2 (uidentificeret)",
      "niveau": "Lav interesse",
      "noter": "Gik hurtigt igennem"
    }
  ],
  "ejendoms_noter_intern": [
    "Køkken fra 1998 — sandsynlig forhandlingschip for købere"
  ],
  "opfoelgning": [
    "Send energimærke + BBR-udskrift til Rasmus og Stine inden fredag",
    "Book 2. fremvisning lørdag"
  ],
  "salgsstatus": "Aktiv — 1 varmt lead"
}
```

**Gap-analyse:**

| Kategori | Generisk output | Mangler |
|---|---|---|
| Interessent-profiler | ⚠️ nævnt i resumé | ❌ ikke som strukturerede kontakt-records |
| Interesse-niveau | ❌ ikke scoret | ❌ mangler |
| Ejendoms-observationer (intern) | ❌ ikke adskilt | ❌ blandet med alt andet |
| Opfølgningshandlinger | ✅ som tasks | ✅ dette klarer generisk okay |
| Salgsstatus/pipeline | ❌ ikke nævnt | ❌ mangler helt |

**Gap-score: 3/5 kategorier mangler**

---

## Sample #3: B2B Sælger

**Transskription:**
> "Okay, jeg er lige kørt fra mødet med Henrik Madsen hos Novo, indkøbsansvarlig for lab-udstyr. Mødet varede en time. De er interesserede i vores ultracentrifuge-serie, budget er godkendt til cirka 800.000. Men Henrik er bekymret for leveringstiden — de har brug for udstyret inden udgangen af september. Konkurrenten Eppendorf har også været inde, de tilbød hurtigere levering ifølge Henrik. Vi skal have fat i vores logistikteam og se om vi kan love september-levering. Send tilbud senest torsdag. Henrik sagde vi måtte ringe til ham direkte på sin mobilnummer, han gav mig det — det er 2345 6789."

**Forventet output fra generisk `analyzePrompt`:**
```json
{
  "title": "Møde med Henrik Madsen, Novo",
  "summary": "Afholdt salgsmøde med Henrik Madsen, indkøbsansvarlig for lab-udstyr hos Novo. De er interesserede i ultracentrifuge-serien med et budget på ca. 800.000 kr. Levering inden september er afgørende, og Eppendorf er en aktiv konkurrent.",
  "tasks": [
    "Kontakt logistikteam om september-levering",
    "Send tilbud til Henrik Madsen inden torsdag",
    "Ring til Henrik på 2345 6789"
  ]
}
```

**Ideelt niche-specifikt output:**
```json
{
  "title": "Mødenotat — Henrik Madsen, Novo",
  "kunde": {
    "navn": "Henrik Madsen",
    "titel": "Indkøbsansvarlig, lab-udstyr",
    "virksomhed": "Novo",
    "direkte_tlf": "2345 6789"
  },
  "moedeinfo": {
    "varighed_min": 60,
    "produkt": "Ultracentrifuge-serien"
  },
  "deal_status": {
    "budget_dkk": 800000,
    "beslutningskriterier": ["Leveringstid — KRITISK (deadline: september)", "Pris"],
    "konkurrenter": ["Eppendorf — tilbød hurtigere levering (intern bekymring)"],
    "sandsynlighed": "Moderat-høj hvis september-levering kan bekræftes"
  },
  "naeste_skridt": [
    { "handling": "Afklar september-levering med logistikteam", "prioritet": "HASTER", "ejer": "mig" },
    { "handling": "Send tilbud til Henrik", "deadline": "torsdag", "ejer": "mig" }
  ],
  "opfoelgningsmail_udkast": "Hej Henrik, tak for mødet i dag. Vi undersøger mulighederne for september-levering og vender tilbage inden torsdag med et konkret tilbud..."
}
```

**Gap-analyse:**

| Kategori | Generisk output | Mangler |
|---|---|---|
| Kontaktdata (struktureret) | ⚠️ navn nævnt i titel | ❌ telefon kun som task, ikke som felt |
| Deal-parametre | ⚠️ budget i resumé | ❌ ikke struktureret |
| Konkurrent-intel | ❌ i resumé, ustruktureret | ❌ ikke som salgs-relevant felt |
| Prioritering af handlinger | ❌ flat liste | ❌ ingen prioritet/ejer/deadline |
| Opfølgningsmail | ❌ ikke nævnt | ❌ mangler helt |

**Gap-score: 4/5 kategorier mangler eller er utilstrækkelige**

---

## Sample #4: Journalist

**Transskription:**
> "Okay jeg er færdig med interview med formanden for lejerforeningen, han hedder Carsten Bloch. Han sagde og jeg citerer: vi har klaget til kommunen seks gange siden 2022, og ikke én gang har vi fået svar. Slut citat. Han nævnte også at der er 34 lejligheder i ejendommen, alle med problemer med fugt og skimmel. Kommunen har ifølge ham haft en besigtigelsesrapport liggende siden marts 2024 men ikke handlet på den. Det er en god vinkel. Husk at tjekke aktindsigt på besigtigelsesrapporten og ring til kommunens tekniske forvaltning for kommentar."

**Forventet output fra generisk `analyzePrompt`:**
```json
{
  "title": "Interview om lejerforening og kommunale klager",
  "summary": "Afholdt interview med Carsten Bloch, formand for lejerforeningen. Han oplyste, at foreningen har klaget til kommunen seks gange siden 2022 uden at modtage svar. 34 lejligheder lider under fugt- og skimmelproblemer, og en besigtigelsesrapport fra marts 2024 er angiveligt ikke behandlet.",
  "tasks": [
    "Anmod om aktindsigt i besigtigelsesrapporten",
    "Ring til kommunens tekniske forvaltning for kommentar"
  ]
}
```

**Ideelt niche-specifikt output:**
```json
{
  "title": "Interview — Carsten Bloch, lejerforening",
  "kilde": {
    "navn": "Carsten Bloch",
    "rolle": "Formand, lejerforeningen",
    "trovaerdighed": "Primær kilde"
  },
  "direkte_citater": [
    "Vi har klaget til kommunen seks gange siden 2022, og ikke én gang har vi fået svar"
  ],
  "fakta_at_verificere": [
    "34 lejligheder med fugt/skimmel — tjek BBR eller ejendomsdata",
    "Besigtigelsesrapport dateret marts 2024 — kræver aktindsigt",
    "'Seks klager siden 2022' — anmod om dokumentation"
  ],
  "vinkler": [
    "Kommunal passivitet trods dokumenteret viden (rapport fra marts 2024)",
    "Lejernes magtesløshed (6 klager, 0 svar)",
    "Omfang: 34 lejligheder = potentielt ~60-80 berørte beboere"
  ],
  "manglende_sider": [
    "Kommunens tekniske forvaltning — kommentar/afvisning",
    "Ejer/udlejer — reaktion"
  ],
  "research_todo": [
    "Aktindsigt: besigtigelsesrapport marts 2024",
    "Ring kommunens tekniske forvaltning",
    "Tjek om lignende sager i kommunen"
  ]
}
```

**Gap-analyse:**

| Kategori | Generisk output | Mangler |
|---|---|---|
| Citat-ekstraktion | ❌ blandet ind i resumé | ❌ ikke markeret som direkte citat |
| Fakta vs. påstand | ❌ ingen distinktion | ❌ mangler helt |
| Vinkler/historieforslag | ❌ ikke nævnt | ❌ mangler helt |
| Manglende kildesider | ❌ ikke nævnt | ❌ mangler helt |
| Research-todo | ✅ som tasks | ✅ dette klarer generisk okay |

**Gap-score: 4/5 kategorier mangler**

---

## Sample #5: Projektleder

**Transskription:**
> "Statusmøde med teamet. Vi er på plan med backend-migreringen, den er 80% færdig ifølge Jonas. Frontend er bagud — Anne sagde hun mangler designfiler fra UX-teamet, det stopper hende. Jeg skal huske at eskalere det til Maria i UX inden i morgen. Deadline for hele migreringen er stadig 6. juni, men det er stramt. Budget er okay, vi er under. Næste statusmøde om en uge."

**Forventet output fra generisk `analyzePrompt`:**
```json
{
  "title": "Statusmøde — backend-migrering",
  "summary": "Statusmøde for backend-migreringen. Backend er 80% færdig ifølge Jonas og er på plan. Frontend er forsinket grundet manglende designfiler fra UX-teamet. Deadline er 6. juni, og budgettet er under kontrol.",
  "tasks": [
    "Eskalér manglende designfiler til Maria i UX inden i morgen",
    "Sæt næste statusmøde om en uge"
  ]
}
```

**Ideelt niche-specifikt output:**
```json
{
  "title": "Statusmøde — Migrerings-projekt",
  "dato": "[i dag]",
  "status_overblik": {
    "backend": { "fremdrift": "80%", "status": "På plan", "ejer": "Jonas" },
    "frontend": { "fremdrift": "Forsinket", "blocker": "Mangler designfiler fra UX", "ejer": "Anne" }
  },
  "risici": [
    "Frontend-forsinkelse truer deadline 6. juni — kritisk afhænger af UX-levering"
  ],
  "budget": "Under budget — OK",
  "action_items": [
    { "handling": "Eskalér designfiler-request til Maria (UX)", "ejer": "mig", "deadline": "i morgen" },
    { "handling": "Book næste statusmøde", "ejer": "mig", "deadline": "om en uge" }
  ],
  "naeste_moede": "Om en uge"
}
```

**Gap-analyse:**

| Kategori | Generisk output | Mangler |
|---|---|---|
| Status per workstream | ⚠️ i resumé, fladt | ❌ ikke struktureret per stream med ejer |
| Blocker-identifikation | ⚠️ nævnt | ❌ ikke markeret som risiko |
| Action items med ejer | ❌ ingen ejer | ❌ "mig" vs. "andre" ikke skelnet |
| Risiko-log | ❌ ikke nævnt | ❌ mangler |
| Budget-status | ⚠️ i resumé | ❌ ikke som struktureret felt |

**Gap-score: 4/5 kategorier utilstrækkelige — MEN outputtet er tættest på det ideelle af alle 5**

---

## Tværgående konklusioner

### Gap-mønster på tværs af niches

Den generiske prompt fejler **konsekvent** på samme kategorier:

1. **Struktur** — Alt havner i fladt resumé. Professionelle har brug for felter, ikke prosa.
2. **Roller og ejerskab** — "bestil X" siger ikke hvem der bestiller, hvornår, hos hvem.
3. **Kategori-adskillelse** — Udført arbejde ≠ Observationer ≠ Handlinger ≠ Bestillinger. Generisk prompt blander dem.
4. **Fagspecifik terminologi** — Ingen opmålinger, ingen SOAP, ingen CRM-felter, ingen citater.
5. **Faktureringsrelevant info** — Tid brugt, materialer forbrugt, hvad kan faktureres — dette er usynligt.

### Hvad er generisk faktisk god til?

- Titel-generering (men for generisk)
- At fange explicit nævnte handlinger som tasks
- Projektleder-casen (nærmest idealet uden niche-tuning)

### Implikation for prompt-design

Vi behøver ikke erstatte prompten — vi skal **precondition** den med niche-kontekst:

```
[GENERISK KERNE]
Du er en produktivitetsassistent...

→ erstattes med →

[NICHE-SPECIFIK]
Du er en assistent for VVS-installatører i Danmark.
Brugeren dikterer noter fra et kundebesøg.
Strukturér altid output med: Kunde/adresse · Udført arbejde (med tidsestimat) · 
Materialer brugt · Observationer (ikke udført) · Bestillinger/indkøb · 
Faktureringsgrundlag.
```

---

## Næste skridt

→ Se `03_prompt_bibliotek/vvs_analyze_v1.md` for første niche-specifikke prompt-design (VVS)

→ Evalueringskriterier for A/B-test defineres i `04_evaluering_metodik.md`
