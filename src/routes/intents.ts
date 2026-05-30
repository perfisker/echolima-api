import { Router, Response } from 'express'
import { getFirestore } from 'firebase-admin/firestore'
import { AuthRequest } from '../types'
import { verifyToken } from '../middleware/auth'
import { getOpenAI, callWithRetry } from '../utils/openai'
import { loadIntentDef, buildNluPrompt, validateSlots } from '../intents/parser'
import { isAllowedEndpoint } from '../intents/allowlist'

const router = Router()

// ─────────────────────────────────────────────────────────────────────────────
// POST /intents/parse — Voice Intent NLU-endpoint
//
// Body: { intentId: string, transcript: string, noteContext?: { tasks?, summary? } }
// Returns: { slots: Record<string, any>, missingRequired: string[] }
//
// Flow:
//   1. Validér body
//   2. Hent intent-def fra cache (apps/{appId}.commonCapabilities.intents)
//   3. Allowlist-check hvis action.type === 'invoke_endpoint' (sikkerhed)
//   4. Hent brugerens kontakter til contact_ref-resolution
//   5. Build NLU-prompt + kald GPT-4o-mini med callWithRetry
//   6. Validér NLU-output mod slot-defs (type + regex)
//   7. Beregn missingRequired-array
//   8. Log telemetri-event (best-effort)
//   9. Returnér { slots, missingRequired }
//
// NLU-cost: ~$0.001-0.005 pr. kald (gpt-4o-mini med ~200-400 input + 50-100 output tokens).
// Alle tiers gratis i V1 (Beslutning #5 i Architecture-doc).
// Rate-limit: generalLimiter (100 req/15min/IP) beskytter mod misbrug.
//
// Allowlist-violations logges som 'intent_allowlist_violation'-event så vi kan
// spotte forsøg på at smug-route via kompromitteret Firestore-state.
// ─────────────────────────────────────────────────────────────────────────────

router.post('/parse', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const uid = req.user!.uid
    const { intentId, transcript, noteContext } = req.body

    // ── 1. Body-validation ──
    if (!intentId || typeof intentId !== 'string') {
      res.status(400).json({ error: 'missing_params', message: 'intentId er påkrævet' })
      return
    }
    if (!transcript || typeof transcript !== 'string') {
      res.status(400).json({ error: 'missing_params', message: 'transcript er påkrævet' })
      return
    }

    // ── 2. Hent intent-def fra cache ──
    const intentDef = await loadIntentDef(intentId)
    if (!intentDef) {
      res.status(404).json({ error: 'intent_not_found', message: `Intent '${intentId}' findes ikke` })
      return
    }

    // ── 3. Allowlist-check for invoke_endpoint (Beslutning #9) ──
    if (intentDef.action.type === 'invoke_endpoint') {
      const params = intentDef.action.params as { endpoint?: string; method?: string }
      const endpoint = params.endpoint ?? ''
      const method = params.method ?? ''
      if (!isAllowedEndpoint(endpoint, method, intentId)) {
        // Log telemetri-event så vi kan se forsøg over tid
        try {
          await getFirestore().collection('events').add({
            uid,
            appId: 'echolima',
            type: 'intent_allowlist_violation',
            intentId,
            endpoint,
            method,
            timestamp: Date.now()
          })
        } catch (logErr) {
          console.error('intents/parse: kunne ikke logge allowlist_violation:', logErr)
        }
        res.status(403).json({ error: 'allowlist_violation', message: 'Endpoint ikke tilladt' })
        return
      }
    }

    // ── 4. Hent brugerens kontakter til contact_ref-resolution ──
    // Adresseres fra users/{uid}/contacts subcollection. Hvis bruger ikke har
    // kontakter endnu, returnerer vi tomt array — NLU producerer bare null for
    // contact_ref-slots.
    const contactsSnap = await getFirestore()
      .collection('users').doc(uid).collection('contacts').get()
    const contacts = contactsSnap.docs.map(d => {
      const data = d.data()
      return {
        name: typeof data.name === 'string' ? data.name : '',
        email: typeof data.email === 'string' ? data.email : undefined
      }
    })

    // ── 5. Build NLU-prompt + kald GPT-4o-mini med retry ──
    // V1.3 (30. maj 2026): Defensiv parsing af noteContext for at sikre at
    // klient-supplied data altid har korrekte typer før vi sender til NLU.
    // Beskytter mod malformed body fra ældre/nyere klient-versioner.
    const rawCtx = noteContext as Record<string, unknown> | undefined
    const safeNoteContext = rawCtx ? {
      tasks: Array.isArray(rawCtx.tasks)
        ? (rawCtx.tasks as unknown[]).filter((t): t is string => typeof t === 'string')
        : undefined,
      summary: typeof rawCtx.summary === 'string' ? rawCtx.summary : undefined,
      extraFieldNames: Array.isArray(rawCtx.extraFieldNames)
        ? (rawCtx.extraFieldNames as unknown[]).filter((n): n is string => typeof n === 'string')
        : undefined
    } : undefined

    const nluPrompt = buildNluPrompt(intentDef, transcript, contacts, safeNoteContext)
    const openai = getOpenAI()

    const completion = await callWithRetry(() =>
      openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'Du er en præcis intent-parser. Returnér KUN gyldigt JSON.' },
          { role: 'user', content: nluPrompt }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.1,           // lavt for at mindske hallucination i slot-extraction
        max_tokens: 400
      })
    )

    let rawSlots: Record<string, unknown> = {}
    try {
      rawSlots = JSON.parse(completion.choices[0].message.content ?? '{}')
    } catch (parseErr) {
      console.error('intents/parse: NLU returnerede ugyldigt JSON:', parseErr)
      // Fortsæt med tomt object — missingRequired-loopet under fanger det
    }

    // ── 6. Validér slots mod slot-defs (type + regex) ──
    const validated = validateSlots(intentDef.slots, rawSlots)

    // ── 7. Beregn missingRequired ──
    const missingRequired = intentDef.slots
      .filter(s => s.required && validated[s.id] == null)
      .map(s => s.id)

    // ── 8. Log telemetri (best-effort — failure her må ikke blokere response) ──
    try {
      const totalTokens = completion.usage?.total_tokens ?? 0
      await getFirestore().collection('events').add({
        uid,
        appId: 'echolima',
        type: 'intentParse',
        intentId,
        success: missingRequired.length === 0,
        missingSlots: missingRequired,
        timestamp: Date.now(),
        tokens: totalTokens,
        // gpt-4o-mini approx cost: input $0.150/1M tokens, output $0.600/1M.
        // Blended estimate: ~$0.000000375/token (vægtet mellem in/out).
        costUsd: totalTokens * 0.000000375
      })
    } catch (logErr) {
      console.error('intents/parse event-log fejl (response sendes alligevel):', logErr)
    }

    // ── 9. Returnér resultat ──
    res.json({ slots: validated, missingRequired })
  } catch (err) {
    console.error('intents/parse fejl:', err)
    res.status(500).json({ error: 'server_error', message: 'Serverfejl' })
  }
})

export default router
