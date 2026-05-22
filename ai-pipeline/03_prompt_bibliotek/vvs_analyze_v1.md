# VVS Analyze Prompt — v1

> **Niche:** VVS-installatør / håndværker  
> **Task:** analyzePrompt (POST /ai/analyze)  
> **Version:** 1.0  
> **Dato:** 17. maj 2026  
> **Status:** Under test — ikke implementeret i produktion

---

## Designbeslutninger

### Hvorfor dette output-format?

VVS'eren dikterer typisk **ét opkald per kundebesøg**, og notatet skal tjene tre formål samtidigt:

1. **Intern hukommelse** — hvad lavede jeg, hvad så jeg?
2. **Faktureringsgrundlag** — hvad kan jeg fakturere kunden for?
3. **Næste-besøg-briefing** — hvad skal jeg huske at gøre/medbringe?

Den generiske prompt blander alle tre formål i én flad tekstblok. Den niche-specifikke prompt adskiller dem i strukturerede felter.

### JSON-format: udvidet vs. backward-compat

Denne v1 returnerer et **udvidet JSON-format** der bryder med det nuværende `{ title, summary, tasks }`.  
Det kræver ændringer i backend (`ai.ts`) og Android (`NoteDetailScreen`, `NoteAnalysisResponse`).

Alternativ (backward-compat): pak alt ind i `summary` som markdown-tekst og brug `tasks` til handlinger. Tester vi som v1b hvis v1 kræver for meget refactor.

---

## Prompten (VALIDERET — v1 final, 15/15)

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
      "tid_min": <antal minutter hvis nævnt, ellers null>
    }
  ],
  "materialer_brugt": [
    {
      "vare": "Varebetegnelse",
      "antal": <antal hvis nævnt, ellers null>,
      "enhed": "stk/meter/liter/etc hvis nævnt"
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

## Forventede forbedringer vs. baseline

| Felt | Baseline | v1 |
|---|---|---|
| Kunde/adresse | I titel (ustruktureret) | Eget `kunde`-felt |
| Udført arbejde | I resumé (prosa) | Struktureret liste med tid |
| Materialer | **Mangler helt** | Struktureret liste med antal |
| Observationer | Blandet med tasks | Adskilt kategori |
| Bestillinger | Som tasks (blandet) | Adskilt kategori |
| Faktureringsgrundlag | **Mangler helt** | Eget felt |

---

## Test-transskriptioner

Se `scripts/evalPrompt.ts` for de 5 sample-transskriptioner der bruges til evaluering.

---

## Evalueringskriterier (til A/B-scoring)

Scoret 0–3 per kriterium:

| Kriterium | 0 | 1 | 2 | 3 |
|---|---|---|---|---|
| **Struktur** | Alt i prosa | Delvist struktureret | God struktur | Perfekt adskillelse af kategorier |
| **Fagterminologi** | Ingen | Lidt | God | Præcis fagterminologi bevaret |
| **Faktureringsrelevans** | Intet fakturerbart | Tid nævnt | Tid + materialer | Komplet faktureringsgrundlag |
| **Handlingspræcision** | Vage tasks | Nogenlunde præcise | Præcise | Præcise + prioriterede |
| **Nøjagtighed** | Fakta tabt/forvansket | Mindre tab | Næsten komplet | Alt fra transskription bevaret |

**Max score: 15**  
Baseline forventes ~5–7. v1 skal ramme ≥11 for at være produktionsklar.

---

## Versionslog

| Version | Dato | Ændring |
|---|---|---|
| v1 | 17. maj 2026 | Første version — udvidet JSON-format |
| v1 final | 17. maj 2026 | Valideret i OpenAI Playground. 3 regelændringer: observationer cross-check, transport tur+retur beregning, anti-hallucination. Score: 15/15 |
