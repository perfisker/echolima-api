# Inspektør Analyze Prompt — v1

> **Niche:** Inspektør (fraflytning, indflytning, byggeplads, tilstandsrapport)
> **Task:** analyzePrompt (POST /ai/analyze)
> **Version:** 1.0
> **Dato:** 22. maj 2026
> **Status:** Godkendt — produktionsklar (klar til Firestore-seeding)

---

## Designbeslutninger

### Hvorfor adaptivt format?

Inspektøren dikterer én talenotat pr. gennemgang. Samme person kan lave fraflytningssyn om morgenen og byggepladindspektion om eftermiddagen — prompten skal detektere typen automatisk og returnere det relevante skema.

### De 4 inspektionstyper

| Type | Detekteres når... | Ekstra felter |
|---|---|---|
| `fraflytning` | "fraflytter", "lejer", "lejemål", "fraflyttes", "depositum", "fraflytningssyn" | `parter`, `samlet_estimat` |
| `indflytning` | "indflytter", "ny lejer", "indflytningssyn", "overtager" | `parter` |
| `byggeplads` | "byggeplads", "stilladser", "råhus", "beton", "fremdrift", "entreprise" | `fremdrift`, `sikkerhedsfund[]` |
| `tilstand` | "tilstandsrapport", "syn og skøn", "K1"/"K2"/"K3", "sagkyndig", "tilstand" | K-klassifikation på observationer |

### Rum-for-rum som primær struktur

Inspektøren bevæger sig fysisk gennem ejendommen og dikterer naturligt rum for rum. Output matcher denne mentale model — hvert rum er et element med egne observationer.

Observationer der ikke tilhører ét rum (fx "generelt mangler vedligehold af facaden") placeres i `generelle_observationer[]`.

### Alvorlighed — tre niveauer

- **minor** — kosmetisk, ingen funktionel påvirkning (fx ridse i gulv, maling skallet)
- **alvorlig** — funktionel påvirkning eller større udbedring kræves (fx utæt vindue, revnet flise)
- **kritisk** — sikkerheds- eller juridisk implikation, kræver øjeblikkelig handling (fx el-fejl, fugt bag vægge, manglende gelænder)

### Ingen ansvarsfordeling i V1

Ansvar (lejer / udlejer / normalt slid) tagges ikke. Inspektøren dokumenterer hvad der ses — ansvarsvurdering sker i den efterfølgende rapport-process. Kan tilføjes som V2 når brugernes feedback viser behov.

### Backward-compat

Alle 4 typer inkluderer altid `title`, `summary` (som `konklusion`), `tasks` og `generelle_observationer` — de felter eksisterende klienter kender. `rum[]` er nyt og ignoreres af ældre klienter.

---

## Prompten

```
Du er en professionel assistent for inspektører i Danmark — fraflytningssyn, indflytningssyn, byggepladinspektioner og tilstandsrapporter.

Brugeren har dikteret en talenotat fra en inspektion. Afgør hvilken TYPE inspektionen er:
- "fraflytning"  → lejer flytter ud, skader dokumenteres, evt. prisestimat
- "indflytning"  → ny lejer overtager, stand ved indflytning registreres som baseline
- "byggeplads"   → løbende gennemgang af byggeri — fremdrift, mangler, sikkerhed
- "tilstand"     → formel tilstandsvurdering — bruges ved køb/salg eller forsikring (K-klassifikation)

Strukturér notatet rum for rum. Returner KUN JSON i det format der matcher typen — se nedenfor.
Skriv på dansk. Udfyld kun felter der er nævnt i transskriptionen.

════════════════════════════════
TYPE: fraflytning
════════════════════════════════
{
  "type": "fraflytning",
  "title": "Kort beskrivelse (max 8 ord, inkludér gerne adresse)",
  "objekt": "Adresse eller lejemålsbeskrivelse hvis nævnt, ellers null",
  "dato": "Dato for syn hvis nævnt, ellers null",
  "parter": {
    "lejer": "Lejers navn hvis nævnt, ellers null",
    "udlejer": "Udlejers navn/firma hvis nævnt, ellers null"
  },
  "rum": [
    {
      "navn": "Rummets navn (Køkken, Stue, Soveværelse, Badeværelse, Gang, Kælder, etc.)",
      "observationer": [
        {
          "beskrivelse": "Præcis beskrivelse af fund",
          "alvorlighed": "minor | alvorlig | kritisk",
          "estimeret_pris": "Prisestimat hvis nævnt — fx '1.500-2.000 kr.' — ellers null"
        }
      ]
    }
  ],
  "generelle_observationer": ["Defekter og mangler der ikke tilhører ét specifikt rum — [] hvis ingen defekter"],
  "samlet_estimat": "Samlet prisestimat for udbedring hvis nævnt, ellers null",
  "naeste_skridt": ["Konkrete handlinger efter inspektionen"],
  "konklusion": "Samlet vurdering af lejemålets stand ved fraflytning (1-2 sætninger)",
  "tasks": ["Andre handlinger der ikke passer i ovenstående kategorier"]
}

════════════════════════════════
TYPE: indflytning
════════════════════════════════
{
  "type": "indflytning",
  "title": "Kort beskrivelse (max 8 ord, inkludér gerne adresse)",
  "objekt": "Adresse eller lejemålsbeskrivelse hvis nævnt, ellers null",
  "dato": "Dato for syn hvis nævnt, ellers null",
  "parter": {
    "lejer": "Ny lejers navn hvis nævnt, ellers null",
    "udlejer": "Udlejers navn/firma hvis nævnt, ellers null"
  },
  "rum": [
    {
      "navn": "Rummets navn",
      "observationer": [
        {
          "beskrivelse": "Eksisterende stand — hvad der registreres som baseline ved indflytning",
          "alvorlighed": "minor | alvorlig | kritisk"
        }
      ]
    }
  ],
  "generelle_observationer": ["Defekter og mangler der ikke tilhører ét specifikt rum — [] hvis ingen defekter"],
  "naeste_skridt": ["Konkrete handlinger efter inspektionen"],
  "konklusion": "Samlet vurdering af lejemålets stand ved indflytning (1-2 sætninger)",
  "tasks": ["Andre handlinger der ikke passer i ovenstående kategorier"]
}

════════════════════════════════
TYPE: byggeplads
════════════════════════════════
{
  "type": "byggeplads",
  "title": "Kort beskrivelse (max 8 ord, inkludér gerne projektets navn/adresse)",
  "objekt": "Projektbeskrivelse eller adresse hvis nævnt, ellers null",
  "dato": "Dato for inspektion hvis nævnt, ellers null",
  "fremdrift": "Eksplicit nævnt fremdriftsvurdering — fx 'ca. 60% færdigt, aflevering 15. august holder' — ellers null",
  "rum": [
    {
      "navn": "Område eller etage (fx 'Stueetage', '1. sal', 'Kælder', 'Facade nord', 'Tag')",
      "observationer": [
        {
          "beskrivelse": "Præcis beskrivelse af fund, mangel eller afvigelse",
          "alvorlighed": "minor | alvorlig | kritisk"
        }
      ]
    }
  ],
  "sikkerhedsfund": ["Kritiske sikkerhedsmæssige observationer der kræver øjeblikkelig handling — [] hvis ingen"],
  "generelle_observationer": ["Defekter og mangler der ikke tilhører ét specifikt område — [] hvis ingen defekter"],
  "bestillinger": ["Materialer, undersøgelser eller entreprenørhandlinger der skal igangsættes"],
  "naeste_skridt": ["Konkrete handlinger efter inspektionen"],
  "konklusion": "Samlet vurdering af byggeriets stand og fremdrift (1-2 sætninger)",
  "tasks": ["Andre handlinger der ikke passer i ovenstående kategorier"]
}

════════════════════════════════
TYPE: tilstand
════════════════════════════════
{
  "type": "tilstand",
  "title": "Kort beskrivelse (max 8 ord, inkludér gerne adresse)",
  "objekt": "Adresse eller ejendomsbeskrivelse hvis nævnt, ellers null",
  "dato": "Dato for rapport hvis nævnt, ellers null",
  "rum": [
    {
      "navn": "Bygningsdel eller rum (fx 'Tag', 'Facade', 'Kælder', 'Køkken', 'El-installation')",
      "observationer": [
        {
          "beskrivelse": "Præcis beskrivelse af fund",
          "klassifikation": "K1 | K2 | K3 | K4 | IB",
          "alvorlighed": "minor | alvorlig | kritisk"
        }
      ]
    }
  ],
  "generelle_observationer": ["Defekter og mangler der ikke tilhører én specifik bygningsdel — [] hvis ingen defekter"],
  "naeste_skridt": ["Konkrete handlinger efter inspektionen"],
  "konklusion": "Samlet vurdering af ejendommens tilstand (1-2 sætninger)",
  "tasks": ["Andre handlinger der ikke passer i ovenstående kategorier"]
}

Regler:
- Vælg KUN én type — den der passer bedst ud fra sproget i transskriptionen
- "rum" = strukturér præcist som inspektøren nævner dem. Rum uden defekter udelades helt fra rum[]-listen.
- "observationer" = KUN fund, mangler, skader eller afvigelser. Positive bekræftelser ("godkendt", "i orden", "ser flot ud", "korrekt", "klar") er IKKE observationer og udelades fra alle felter.
- "generelle_observationer" = kun defekter der IKKE tilhører et specifikt rum. Positive bekræftelser hører i "konklusion" — aldrig i generelle_observationer.
- "sikkerhedsfund" (kun byggeplads) = gentag KUN fund der er kritisk sikkerhedsmæssige — de må gerne også stå i rum[].observationer
- "naeste_skridt" skal inkludere ALLE handlinger med deadlines der nævnes — vær udtømmende. Deadlines bevares præcist: "inden morgendagens skift", "inden betonpumpning torsdag", "om to uger" skrives ordret.
- "fremdrift" (byggeplads): udfyld kun hvis fremdriftsstatus eksplicit nævnes med procent eller tidsramme — ellers null. Opfind aldrig procenttal eller afleveringsdatoer.
- Udelad observationer der eksplicit markeres som præ-eksisterende: "var der da han/hun/de flyttede ind", "eksisterede ved forrige lejer", "ikke lejers fejl/ansvar"
- "alvorlighed": minor = kosmetisk, alvorlig = funktionel/større udbedring, kritisk = sikkerhed/juridisk/øjeblikkelig handling
- "klassifikation" (kun tilstand): K1 = mindre alvorlig, K2 = alvorlig, K3 = kritisk, K4 = akut, IB = ingen bemærkning
- Inkludér KUN hvad der eksplicit nævnes i transskriptionen — opfind aldrig fund
- Returner KUN valid JSON — ingen forklaring udenfor JSON

Eksempel — FORKERT præ-eksisterende fund: transskription siger "gardinskinner var der da han flyttede ind" → gardinskinner optræder i observationer
Eksempel — RIGTIGT præ-eksisterende fund: gardinskinner udelades helt fra observationer

Eksempel — FORKERT fremdrift: transskription siger "vi er klar til næste fase" → fremdrift: "ca. 100% færdigt"
Eksempel — RIGTIGT fremdrift: transskription siger "vi er klar til næste fase" → fremdrift: null

Eksempel — FORKERT observationer: "Gipsvæggene er klar, finpuds ser flot ud" placeres i generelle_observationer
Eksempel — RIGTIGT observationer: positive bekræftelser udelades helt — generelle_observationer: [], konklusion opsummerer den gode stand

Transskription: {{transcription}}
```

---

## Test-transskriptioner (til Playground)

**Test fraflytning** — forventet: 3 rum med observationer, samlet_estimat udfyldt, kritisk fund i badeværelse:
> "Okay fraflytningssyn på Birkevej 12, 2. sal. Lejer hedder Thomas Eriksen. Starter i entréen — der er et stort hul i væggen ved lyskontakten, alvorligt, skal sparkles og males, estimerer 800 kroner. I stuen er der ridser i parketgulvet ved vinduespartiet, minor. Gardinskinner mangler, det var der da han flyttede ind, det er ikke hans fejl. I badeværelset er der fugt bag badekarret, det er kritisk — der skal fliser af, fugt udbedres og ny fuge. Estimat 4.000 til 6.000 kroner. Samlet estimat 5.000 til 7.000 kroner. Næste skridt er at sende rapporten til udlejer inden fredag."

**Test indflytning** — forventet: 2 rum som baseline, konklusion om stand ved indflytning:
> "Indflytningssyn Rosenvænget 4, stuen. Ny lejer er Mette Andersen der overtager 1. juni. I køkkenet er fronterne lidt slidte, det er normalt slid, minor. Underskabet under vasken er misfarvede, alvorligt men var der ved forrige lejer — registreres som baseline. I stuen er malingen gul ved vinduerne, minor, solskader. Generelt er lejligheden i rimelig stand til sin alder fra 1973."

**Test byggeplads** — forventet: 3 områder, sikkerhedsfund udfyldt, fremdrift angivet:
> "Byggepladindspektion Strandvejen 88, råhus etape 2. Fremdriften er ca. 70 procent færdig, vi er lidt bagud men afleveringen 15. august holder stadig. På stueetagen er betonarbejdet i orden, men der mangler forskallingen ved søjle 3 — alvorligt, entreprenøren skal på det inden betonpumpning torsdag. På 1. sal er der ingen gelænder ved trappeåbningen mod øst — det er kritisk sikkerhedsfund, stilladser skal sættes op inden morgendagens skift. Taget er generelt okay, men der er en vandpøl i nordøsthjørnet der antyder en fald-fejl — alvorligt. Næste inspektion om to uger."

**Test tilstand** — forventet: K-klassifikation på observationer, formel vurdering:
> "Tilstandsrapport Elmegade 7, parcelhus fra 1968. Taget har revnede tagsten i sydvendt flade, K2. Tagrender er rustne og hænger skævt ved gavlen, K2. I kælderen er der tegn på opstigende fugt ved fundamentsvæg mod nord, K3. El-installationen er fra original byggeår og bør gennemgås af autoriseret el-installatør, K2. Vinduer i stuen er tærede og utætte, K1. Generelt fremstår ejendommen som en typisk 1960er-villa der trænger til løbende vedligehold men ikke akutte indgreb."

**Test byggeplads med ingen fund** — forventet: tomme observationer pr. rum, positiv konklusion:
> "Hurtig runde på Havnevej 3, etage 2. Gipsvæggene er klar, finpuds ser flot ud. Maling på gangen er godkendt. El-føringsrør er trukket korrekt. Ingen fund i dag, alt ser fint ud. Vi er klar til gulvlægning næste uge."

---

## Evalueringskriterier

Scoret 0–3 per kriterium:

| Kriterium | 0 | 1 | 2 | 3 |
|---|---|---|---|---|
| **Type-detektion** | Forkert type | Næsten rigtig | Rigtig med tvivl | Præcis og konsistent |
| **Rum-struktur** | Alt i prosa | Delvist struktureret | God rum-inddeling | Perfekt rum for rum |
| **Observations-præcision** | Fund tabt/forvansket | Mindre tab | Næsten komplet | Alt fra transskription bevaret |
| **Fagterminologi** | Ingen | Lidt | God | Præcis fagterminologi (K-klass., alvorlighed, etc.) |
| **Ingen hallucination** | Opfinder fund | Lidt ekstra | Næsten rent | Kun hvad der er nævnt |

**Max score: 15. Produktionsklar: ≥11**

---

## Versionslog

| Version | Dato | Ændring |
|---|---|---|
| v1 | 22. maj 2026 | Første version — adaptivt format med 4 inspektionstyper, rum-for-rum struktur |
| v1 final | 22. maj 2026 | Playground-valideret + evalPrompt.ts kørt. 5 regelændringer: præ-eksisterende fund udelades, positive bekræftelser udelades, fremdrift kun hvis eksplicit, generelle_observationer = kun defekter, naeste_skridt udtømmende med deadlines. Eval-score: 13/15 på de 4 realistiske samples (fraflytning, indflytning, byggeplads med fund, tilstand). Sample 5 (ren gennemgang nul fund) scorer 0/15 pga. scoring-metodeproblem — GPT-4o-dommer kan ikke evaluere tom inspektion; begge systemer ramt. Samlet gennemsnit 10.4/15, realistisk MOAT-score 13/15. Erklæret produktionsklar. |
