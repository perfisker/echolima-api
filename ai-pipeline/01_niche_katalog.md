# AidKick — Niche-katalog (Deliverable #1)

> **Workspace:** EchoLima AI Pipeline & MOAT  
> **Dato:** 17. maj 2026  
> **Formål:** Rangere 5–7 niche-kandidater efter MOAT-potentiale som grundlag for prompt-design

---

## Hvad definerer en god MOAT-niche?

Før rangeringen: vi vurderer niches på 5 dimensioner:

| Dimension | Hvad vi ser efter |
|---|---|
| **Output-specificitet** | Hvor struktureret og niche-specifikt er det ideelle output? Jo mere specifikt → jo sværere at kopiere med generisk AI |
| **Gap til ChatGPT** | Hvor dårligt klarer den generiske "titel + resumé + opgaver"-prompt sig? Stort gap = stor MOAT |
| **Brugshyppighed** | Bruger de talenoter dagligt? Sporadisk brug = svag monetisering |
| **Markedsstørrelse DK** | Er der nok potentielle brugere i Danmark til at gøre det til en vertikal? |
| **Betalingsvillighed** | Er det en professionel kontekst hvor brugerne betaler for tidsbesparelser? |

---

## Niche-kandidater — rangeret

### 🥇 #1: VVS'er / Håndværker (generelt)

**Undervarianter:** VVS-installatør, elektriker, tømrer, murer, maler

**Jobs-to-be-done:**
- Dokumentere arbejde på stedet (opmålinger, observationer, fejl fundet)
- Generere kundevendt tilbuds- eller statusnotat
- Huske materialeliste til næste dag / næste besøg
- Lave faktureringsgrundlag ("hvad lavede jeg hos Andersen i dag?")

**Hvad ville være "magisk" output:**
```
Opmåling: 3,4 m² flisearbejde, badeværelse 1. sal
Materialer: ~18 stk. 20×20 fliser, fugmasse (hvid), afretningslag
Næste skridt: Bestil fliser fra Davidsen, hent tirsdag
Til kunden: Arbejdet forventes at tage 4 timer + materialer
```

**Gap til ChatGPT i dag:** Meget stort. Generisk prompt giver "Titel: Badeværelse. Resumé: Du talte om fliser. Opgaver: [køb fliser]". Ingen opmålinger, ingen materialeliste, ingen kundenotat-format.

**Markedsstørrelse DK:** ~80.000 beskæftigede i bygge- og anlægsbranchen. Af disse er VVS alene ~18.000. Stor gruppe.

**Betalingsvillighed:** Høj. Håndværkere fakturerer 500–900 kr/timen. Én sparet times administration om dagen er 10.000+ kr/md i frigjort kapacitet. 49–99 kr/md er trivielt.

**MOAT-score: 9/10** — Kombinationen af snavsede hænder (perfekt use case for stemmenote), meget specifikt output-format og stort gap gør dette til den oplagte #1.

---

### 🥈 #2: Ejendomsmægler

**Jobs-to-be-done:**
- Diktere fremvisningsnotat mens de er på stedet ("hvad lagde jeg mærke til?")
- Generere salgstekst / objektbeskrivelse
- Notere køberinteresser og opfølgningshandlinger
- Dokumentere stand ved overtagelse

**Hvad ville være "magisk" output:**
```
Ejendom: Gl. Kongevej 44, 3. tv
Fremvisningsnotat (intern): Lyse rum, men køkken trænger til renovering. 
  Interessent: Lars (tlf. nævnt) — vil gerne have 2. fremvisning med kone
Opfølgning: Ring Lars torsdag, send energimærke
Til salgsmateriale: [udkast til objektbeskrivelse med BBR-venlige formuleringer]
```

**Gap til ChatGPT i dag:** Stort. Ingen ejendomsmægler-terminologi, ingen opdeling intern/ekstern, ingen opfølgningsstruktur.

**Markedsstørrelse DK:** ~4.500 ejendomsmæglere i DK. Lille, men høj betalingsvillighed og høj brugshyppighed (5–10 fremvisninger/uge).

**Betalingsvillighed:** Meget høj. De er vant til at betale for CRM, digitale salgsplatforme, fotografi. 99 kr/md er ingenting.

**MOAT-score: 8/10** — Meget specifikt output-format, høj betalingsvillighed, men relativt lille marked i DK.

---

### 🥉 #3: Sælger (B2B feltsal)

**Undervarianter:** Farmaceutisk salg, industrisalg, IT-salg, forsikring

**Jobs-to-be-done:**
- Lave mødenotat direkte efter kundebesøg (mens i bilen)
- Opdatere CRM-lignende struktur (hvem sagde hvad, hvad er næste skridt)
- Identificere signaler og indvendinger fra mødet
- Generere opfølgningsmail-udkast

**Hvad ville være "magisk" output:**
```
Kunde: Mads Nielsen, Indkøbschef, Vestas Odense
Dato: i dag, møde ~45 min
Nøglepunkter: Interesseret i Q3-levering, budget godkendt til 500k. 
  Indvending: bekymret for serviceaftale
CRM-opdatering: Stage → "Tilbud sendt", Sandsynlighed 60%
Opfølgning: Send tilbud inden fredag, book demo med tekniker
Opfølgningsmail-udkast: [klar til kopi]
```

**Gap til ChatGPT i dag:** Moderat-stort. ChatGPT kan sagtens lave et mødenotat, men det er ikke formateret til CRM, og det identificerer ikke "signaler" vs. "fakta" vs. "handlinger".

**Markedsstørrelse DK:** ~50.000+ erhvervssælgere i DK. Stort marked.

**Betalingsvillighed:** Høj. Sælgere er vant til at betale for værktøjer (Salesforce, LinkedIn Sales Navigator). 

**MOAT-score: 7/10** — Stor gruppe og tydelig use case, men konkurrence fra CRM-integreret AI er mere sandsynlig her end i håndværker-nichen.

---

### #4: Hjemmepleje / SOSU-assistent

**Jobs-to-be-done:**
- Lave observationsnotat efter besøg hos borger ("hvad var anderledes i dag?")
- Dokumentere medicin givet, måltider, humør
- Notere ting der skal eskaleres til sygeplejerske/leder

**Hvad ville være "magisk" output:**
```
Borgernavn: [anonymiseret i denne demo]
Besøg: ca. 45 min, morgenmad + medicin
Observationer: Lidt forvirret, sov dårligt. Sagde arm gør ondt.
  Medicin givet: ✓ (morgenpakke)
Eskalér til: Sygeplejerske — smerter i arm, tjek ASAP
Næste besøg: I morgen kl. 8
```

**Gap til ChatGPT i dag:** Meget stort. Ingen borgerfokuseret struktur, ingen eskaleringslogik, ingen omsorgsterminologi.

**Markedsstørrelse DK:** ~100.000 SOSU-ansatte. Meget stort.

**Udfordringer:** GDPR er et reelt problem (borgerpersondata). Kræver sandsynligvis særskilt databehandleraftale og måske on-premise løsning. Beslutningsvej er kompleks (kommunale indkøb, ikke individuel download). 

**MOAT-score: 7/10** — Enormt market fit og output-specificitet, men regulatoriske barrierer gør det til et B2B-kommunalt salg, ikke en konsument-app. Potentielt kræver separat produkt.

---

### #5: Journalist / Indholdsproducent

**Jobs-to-be-done:**
- Diktere observationer i felten (demonstration, møde, interview)
- Trække citater ud fra løs tale
- Identificere vinkler og historier
- Lave research-noter der kan bruges direkte i artiklen

**Hvad ville være "magisk" output:**
```
Kilde: [navn nævnt i optagelse]
Direkte citater: "Vi er trætte af at blive ignoreret" · "Det har stået på i 3 år"
Mulige vinkler: (1) kommunens manglende reaktion, (2) beboernes organisering
Facts at verificere: 3 år = siden 2023?, antal beboere nævnt = 42
Research-noter: Tjek kommunens budgetallokering, ring til formand
```

**Gap til ChatGPT i dag:** Moderat. ChatGPT kan lave resumé, men identificerer ikke citater vs. parafrase, og foreslår ikke automatisk vinkling.

**Markedsstørrelse DK:** ~8.000 journalister i DK + frilansjournalister + content-producenter (~20.000 totalt). Relativt lille.

**Betalingsvillighed:** Moderat. Journalister er ikke vant til at betale for individuelle tools. Medier betaler for redaktionssystemer, ikke den enkelte journalist.

**MOAT-score: 6/10** — Meget specifikt og interessant output, men lille betalende marked i DK.

---

### #6: Projektleder / Konsulent

**Jobs-to-be-done:**
- Lave mødereferat med action items og ejerskab
- Diktere statusopdatering til stakeholders
- Fange beslutninger og forudsætninger fra møder

**Hvad ville være "magisk" output:**
```
Møde: Statusmøde Projekt X, [dato]
Beslutninger: Go på fase 2, budget godkendt til 2,3M
Action items:
  - @Anne: Leverandørkontrakt → deadline fredag
  - @Bo: Testmiljø opsættes i uge 22
  - @Per: Risikolog opdateres inden næste møde
Næste møde: [dato nævnt]
```

**Gap til ChatGPT i dag:** Lille-moderat. ChatGPT klarer faktisk dette ret godt med en god prompt. MOAT'en er lavere fordi generisk AI allerede er tæt på det ideelle.

**Markedsstørrelse DK:** ~30.000 projektledere + konsulenter. Moderat.

**Betalingsvillighed:** Høj — men de har adgang til mange AI-tools via arbejdsgiveren (Microsoft Copilot, etc.).

**MOAT-score: 5/10** — Godt use case, men generiske AI-tools er allerede tæt på det ideelle. Svær MOAT at bygge.

---

### #7: Læge / Sundhedspersonale (privat sektor)

**Jobs-to-be-done:**
- Diktere journalnotat efter konsultation (SOAP-format)
- Notere behandlingsplan og opfølgning
- Strukturere observationer fra patientsamtale

**Hvad ville være "magisk" output:**
```
SOAP-notat:
S (Subjektivt): Patient klager over smerter i venstre skulder, 3/10, siden i fredags
O (Objektivt): ROM nedsat, ingen hævelse
A (Vurdering): Sandsynlig impingement
P (Plan): Ultralyd-henvisning, paracetamol ved behov, kontrol om 3 uger
```

**Gap til ChatGPT i dag:** Meget stort. ChatGPT ved ikke hvad SOAP er medmindre du beder om det.

**Markedsstørrelse DK:** ~25.000 læger + klinisk personale i privat sektor (der ikke har adgang til Sundhedsplatformen). Moderat.

**Udfordringer:** Samme GDPR-problemer som SOSU. Patientdata er særligt følsomme. Kan i praksis kun bruges uden patientidentifikation i notaterne — dvs. diktér om "patient" ikke "Jens Hansen". Compliance-risiko er meget høj.

**MOAT-score: 5/10** — Fantastisk output-specificitet, men compliance-risiko er en showstopper for consumer-app. Kræver særskilt regulatorisk arbejde.

---

## Samlet rangeringsoversigt

| Rank | Niche | MOAT | Output-spec | Gap til GPT | Marked DK | Betalingsvilje | Barrierer |
|------|-------|------|------------|------------|-----------|----------------|-----------|
| 1 | VVS / Håndværker | 9/10 | Meget høj | Meget stort | Stor | Høj | Lave |
| 2 | Ejendomsmægler | 8/10 | Høj | Stort | Lille | Meget høj | Lave |
| 3 | Sælger (B2B felt) | 7/10 | Høj | Moderat | Stor | Høj | Moderate (CRM-konkurrence) |
| 4 | Hjemmepleje / SOSU | 7/10 | Meget høj | Meget stort | Meget stor | Lav/kommunal | Høje (GDPR, B2B-salg) |
| 5 | Journalist | 6/10 | Høj | Moderat | Lille | Moderat | Moderate |
| 6 | Projektleder | 5/10 | Moderat | Lille | Moderat | Høj | Moderate (Copilot) |
| 7 | Læge (privat) | 5/10 | Meget høj | Meget stort | Moderat | Høj | Meget høje (GDPR) |

---

## Anbefaling: Start med disse 3

**Fase 1-niches (anbefales til promptdesign):**

1. **VVS / Håndværker** — Klar #1. Laveste barrierer, størst gap, perfekt fit for "beskidte hænder"-positionen. Start med VVS specifikt (har mest specifikt fagsprog og output-format).

2. **Ejendomsmægler** — Lille marked men meget betalingsstærkt og let at ramme med præcist output-format. God til at demonstrere MOAT-konceptet.

3. **Sælger (B2B felt)** — Størst volumen. Kan bruges som "gateway" til den brede professionelle bruger.

**Fase 2 (tilføj når fase 1 er valideret):**
- Journalist (output-mæssigt interessant, lille marked)
- SOSU (enormt potentiale, men kræver separat produktstrategi)

**Hold ude foreløbig:**
- Læge og projektleder — for lav MOAT hhv. for høje barrierer.

---

## Næste skridt

→ Se `02_baseline_evaluering.md` for analyse af hvad den nuværende generiske prompt faktisk producerer for disse niches.

→ Når niche er valgt: Prompt-design for VVS i `03_prompt_bibliotek/vvs_analyze_v1.md`
