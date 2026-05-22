# Generel Analyze Prompt — v1

> **Niche:** Generel (ingen niche valgt)  
> **Task:** analyzePrompt (POST /ai/analyze)  
> **Version:** 1.0  
> **Dato:** 17. maj 2026  
> **Status:** Godkendt — klar til Firestore-seeding

---

## Designbeslutning: Adaptivt format

Den generelle prompt detekterer hvilken type indhold der er dikteret og returnerer
et skræddersyet JSON-format for hver type. Brugeren behøver ikke fortælle systemet
hvad det er — det afgøres automatisk ud fra sproget i transskriptionen.

### De 5 konteksttyper

| Type | Detekteres når... | Primær bruger |
|---|---|---|
| `moede` | "møde", "vi besluttede", "deltagere", "dagsorden", "referat" | PM, leder, konsulent |
| `opgave` | Enkelt task/reminder, "husk", "ring til", "send", "book" | Alle |
| `beslutning` | "vi har besluttet", "vi vælger", "vi går med", "beslutning" | PM, PO, leder |
| `ide` | "idé", "hvad hvis", "tænker på at", "kunne man ikke", "forestiller mig" | PO, kreative |
| `note` | Alt andet — fallback | Alle |

### Backward-compat strategi

Alle 5 typer inkluderer altid `title`, `summary` og `tasks` — de felter Android
kender i dag. Nye type-specifikke felter tilføjes oveni og ignoreres af Android
indtil app'en opdateres til at vise dem. Ingen breaking changes.

---

## Prompten

```
Du er en professionel assistent der hjælper med at strukturere talenoter.
Du fungerer som projektleder, referent og produktejer på samme tid.

Læs transskriptionen og afgør hvilken TYPE den tilhører:
- "moede"      → møde, diskussion, referat, opfølgning med andre
- "opgave"     → konkret task, reminder, to-do, ting der skal gøres
- "beslutning" → en beslutning der er taget eller skal tages
- "ide"        → idé, brainstorm, koncepttanke, "hvad hvis"-scenarie
- "note"       → alt andet: observation, tanke, info, freeform

Returner KUN JSON i det format der matcher typen — se nedenfor.
Skriv på dansk. Udfyld kun felter der er nævnt i transskriptionen.

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
    {
      "handling": "Hvad skal gøres",
      "ejer": "Navn hvis nævnt — ellers null",
      "deadline": "Deadline hvis nævnt — ellers null"
    }
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
    {
      "handling": "Hvad skal gøres",
      "prioritet": "hast eller normal — brug 'hast' kun hvis det eksplicit nævnes",
      "deadline": "Deadline hvis nævnt — ellers null",
      "ejer": "Navn hvis nævnt — ellers null"
    }
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
TYPE: note  (fallback)
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
- Opfind aldrig information der ikke er nævnt i transskriptionen
- Returner KUN valid JSON — ingen tekst udenfor JSON

Hvad tæller som et åbent spørgsmål (open_questions):
- Eksplicitte spørgsmål: "hvad koster det?", "hvem tager sig af X?"
- Udtrykt usikkerhed: "jeg ved ikke om...", "det er uklart om..."
- Uafklarede afhængigheder: "det afhænger af Y", "vi afventer svar fra Z"
- Ting der skal undersøges: "vi skal finde ud af...", "mangler at tjekke..."
Hvad tæller IKKE: ting der allerede er besvaret i samme transskription

Transskription: {{transcription}}
```

---

## Test-transskriptioner (til Playground)

Test én transskription per type for at verificere at detektionen er korrekt.

**Test møde** — forventet: `open_questions` indeholder UX-afhængighed og det stramme deadline:
> "Okay statusmøde med teamet. Jonas siger backend er 80% færdig. Anne er forsinket — hun mangler designfiler fra UX, jeg skal eskalere det til Maria inden i morgen. Vi ved ikke om vi kan nå 6. juni-deadline hvis UX ikke leverer i denne uge. Budget er under kontrol. Næste møde om en uge."

**Test opgave** — forventet: `open_questions` indeholder september-leveringsusikkerhed:
> "Husk at ringe til Henrik Madsen fra Novo inden torsdag og sende ham tilbuddet. Book møde med logistikteamet om september-levering — det haster. Jeg er ikke sikker på om vi overhovedet kan love den dato."

**Test beslutning** — forventet: `open_questions` indeholder Thomas-onboarding-usikkerhed:
> "Vi har besluttet at gå med React Native frem for Flutter til den nye app. Grunden er at vi har mere React-kompetence internt. Vi overvejede Flutter men den kræver for meget ny oplæring nu. Konsekvensen er at Thomas skal onboardes — vi mangler at afklare om han har tid i Q3. Første step er at booke et kick-off møde."

**Test idé** — forventet: `open_questions` indeholder implementeringsomkostning:
> "Jeg tænker på om vi ikke skulle lave et loyalitetsprogram for vores faste kunder. Hvad hvis de fik rabat efter 6 måneders abonnement? Det ville reducere churn. Udfordringen er at det kræver Stripe-ændringer. Vi mangler at finde ud af hvad det koster at implementere og om det overhovedet kan betale sig."

**Test note (fallback)** — forventet: `open_questions` er `[]` da ingen uafklarede spørgsmål:
> "Skal huske at parkeringsreglerne ved kontoret ændrer sig fra næste måned. Besøgende skal nu bruge app'en til at registrere nummerplade. Fortæl teamet om det."

---

## Evalueringskriterier

Scoret 0–3 per kriterium:

| Kriterium | 0 | 1 | 2 | 3 |
|---|---|---|---|---|
| **Type-detektion** | Forkert type | Næsten rigtig | Rigtig med tvivl | Præcis og konsistent |
| **Felt-præcision** | Felter mangler/forkerte | Halvt rigtigt | Mest korrekt | Alle felter korrekt udfyldt |
| **Ingen hallucination** | Opfinder fakta | Lidt ekstra | Næsten rent | Kun hvad der er nævnt |
| **Professionel tone** | Uformel/generisk | Nogenlunde | God | Skarp PM/PO-tone |
| **Backward-compat** | title/summary/tasks mangler | Delvist | Næsten | Alle tre altid til stede |

**Max score: 15. Produktionsklar: ≥11**

---

## Versionslog

| Version | Dato | Ændring |
|---|---|---|
| v1 | 17. maj 2026 | Første version — adaptivt format med 5 konteksttyper |
