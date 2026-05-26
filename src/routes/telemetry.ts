import { Router, Response } from 'express'
import { getFirestore } from 'firebase-admin/firestore'
import { AuthRequest } from '../types'
import { verifyToken } from '../middleware/auth'

const router = Router()

// ─────────────────────────────────────────────────────────────────────────────
// Telemetry — Capability-events
//
// Tre endpoints til at logge capability-brug fra Android-klienten.
// Events skrives til Firestore events-collection (samme collection som
// aiSummary, visionCall, transcription — for aggregeret cost/stats-analyse).
//
// Android kalder disse endpoints defensivt: fejl i telemetry-kald må ALDRIG
// påvirke brugerflowet. Sæt timeout lavt på klient-siden og ignorer fejl.
//
// Event-typer (se arkitektur-doc §3 Q7):
//   capability_invoked — bruger aktiverede en capability
//   capability_failed  — capability kunne ikke aktiveres (parse/tier/version)
//   capability_listed  — bruger åbnede "hvad kan jeg sige"-skærmen
//
// Alle events inkluderer uid (fra JWT) og timestamp (server-side) automatisk.
// ─────────────────────────────────────────────────────────────────────────────

// POST /telemetry/capability_invoked
// Body: { nicheId: string, capabilityId: string, tierId?: string, clientVersion?: string }
//
// Logges når bruger succesfuldt aktiverer en capability (fx stemmekommando
// matchet og action dispatched). Giver indsigt i hvilke capabilities der
// faktisk bruges og af hvilke tiers.
router.post('/capability_invoked', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const uid = req.user!.uid
    const { nicheId, capabilityId, tierId, clientVersion } = req.body

    if (!nicheId || typeof nicheId !== 'string') {
      res.status(400).json({ error: 'bad_request', message: 'nicheId er påkrævet' })
      return
    }
    if (!capabilityId || typeof capabilityId !== 'string') {
      res.status(400).json({ error: 'bad_request', message: 'capabilityId er påkrævet' })
      return
    }

    const event: Record<string, any> = {
      uid,
      type: 'capability_invoked',
      nicheId,
      capabilityId,
      timestamp: Date.now()
    }
    // Optional felter — inkluderes kun hvis til stede (undgår undefined i Firestore)
    if (typeof tierId === 'string') event.tierId = tierId
    if (typeof clientVersion === 'string') event.clientVersion = clientVersion

    await getFirestore().collection('events').add(event)
    res.json({ logged: true })
  } catch (err) {
    console.error('telemetry/capability_invoked fejl:', err)
    res.status(500).json({ error: 'server_error', message: 'Serverfejl' })
  }
})

// POST /telemetry/capability_failed
// Body: {
//   nicheId?: string,
//   capabilityId: string,
//   reason: 'unknown_action' | 'tier_locked' | 'parse_error' | 'version_too_old'
// }
//
// Logges når Android springer en capability over pga. fejl. Giver indsigt i:
//   - Stale clients der støder på ukendte action-typer (unknown_action)
//   - Tier-konverteringspotentiale (tier_locked — bruger forsøgte premium-feature)
//   - Defekte capabilities i Firestore (parse_error — bør alerts)
//   - Clients der er for gamle (version_too_old)
//
// nicheId er optional: ved global/app-level capabilities kendes niche ikke altid.
router.post('/capability_failed', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const uid = req.user!.uid
    const { nicheId, capabilityId, reason } = req.body

    if (!capabilityId || typeof capabilityId !== 'string') {
      res.status(400).json({ error: 'bad_request', message: 'capabilityId er påkrævet' })
      return
    }

    const VALID_REASONS = ['unknown_action', 'tier_locked', 'parse_error', 'version_too_old']
    if (!reason || !VALID_REASONS.includes(reason)) {
      res.status(400).json({
        error: 'bad_request',
        message: `reason skal være én af: ${VALID_REASONS.join(', ')}`
      })
      return
    }

    const event: Record<string, any> = {
      uid,
      type: 'capability_failed',
      capabilityId,
      reason,
      timestamp: Date.now()
    }
    if (typeof nicheId === 'string') event.nicheId = nicheId

    await getFirestore().collection('events').add(event)
    res.json({ logged: true })
  } catch (err) {
    console.error('telemetry/capability_failed fejl:', err)
    res.status(500).json({ error: 'server_error', message: 'Serverfejl' })
  }
})

// POST /telemetry/capability_listed
// Body: { nicheId: string, count: number }
//
// Logges når bruger åbner "hvad kan jeg sige"-skærmen for en niche.
// count = antal capabilities vist (efter tier-filtrering på klient-siden).
// Giver indsigt i feature-discovery: ved vi ikke om brugere finder capabilities,
// kan vi ikke iterere meningsfuldt på dem.
router.post('/capability_listed', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const uid = req.user!.uid
    const { nicheId, count } = req.body

    if (!nicheId || typeof nicheId !== 'string') {
      res.status(400).json({ error: 'bad_request', message: 'nicheId er påkrævet' })
      return
    }
    if (typeof count !== 'number' || count < 0) {
      res.status(400).json({ error: 'bad_request', message: 'count skal være et ikke-negativt tal' })
      return
    }

    await getFirestore().collection('events').add({
      uid,
      type: 'capability_listed',
      nicheId,
      count,
      timestamp: Date.now()
    })
    res.json({ logged: true })
  } catch (err) {
    console.error('telemetry/capability_listed fejl:', err)
    res.status(500).json({ error: 'server_error', message: 'Serverfejl' })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// Voice Intent Telemetri (V1.1+)
// Architecture-doc §3 — adgang fra Android-WS' DraftIntent state machine.
// Disse events bruges til at måle intent-success-rate, ASK-trigger-frekvens,
// og at spotte ofte-fejlende intents der skal optimeres.
// ─────────────────────────────────────────────────────────────────────────────

// POST /telemetry/intent_invoked
// Body: { intentId: string, success: boolean, durationMs?: number, clientVersion?: string }
//
// Logges når Android har færdig-håndteret en intent (uanset om POSTen til
// allowlisted endpoint lykkedes). success=true betyder hele flow gennemførtes,
// success=false betyder fejlede på et tidspunkt (typisk efter klient-confirm).
router.post('/intent_invoked', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const uid = req.user!.uid
    const { intentId, success, durationMs, clientVersion } = req.body

    if (!intentId || typeof intentId !== 'string') {
      res.status(400).json({ error: 'bad_request', message: 'intentId er påkrævet' })
      return
    }
    if (typeof success !== 'boolean') {
      res.status(400).json({ error: 'bad_request', message: 'success (boolean) er påkrævet' })
      return
    }

    const event: Record<string, any> = {
      uid,
      appId: 'echolima',
      type: 'capability_intent_invoked',
      intentId,
      success,
      timestamp: Date.now()
    }
    if (typeof durationMs === 'number') event.durationMs = durationMs
    if (typeof clientVersion === 'string') event.clientVersion = clientVersion

    await getFirestore().collection('events').add(event)
    res.json({ logged: true })
  } catch (err) {
    console.error('telemetry/intent_invoked fejl:', err)
    res.status(500).json({ error: 'server_error', message: 'Serverfejl' })
  }
})

// POST /telemetry/intent_failed
// Body: { intentId: string, reason: string, missingSlots?: string[] }
//
// Logges når en intent ikke kunne gennemføres. Reason giver indsigt i HVOR
// fejlen skete: parse_failed (NLU returnerede intet brugbart), missing_required
// (ASK-pattern blev nødvendigt og fejlede), allowlist_violation (kompromitteret
// config), validation_failed (slot-format ikke godkendt), rate_limited
// (OpenAI rate limit), server_error (anden serverfejl).
router.post('/intent_failed', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const uid = req.user!.uid
    const { intentId, reason, missingSlots } = req.body

    if (!intentId || typeof intentId !== 'string') {
      res.status(400).json({ error: 'bad_request', message: 'intentId er påkrævet' })
      return
    }

    const VALID_REASONS = [
      'parse_failed',
      'missing_required',
      'allowlist_violation',
      'validation_failed',
      'rate_limited',
      'server_error'
    ]
    if (!reason || !VALID_REASONS.includes(reason)) {
      res.status(400).json({
        error: 'bad_request',
        message: `reason skal være én af: ${VALID_REASONS.join(', ')}`
      })
      return
    }

    const event: Record<string, any> = {
      uid,
      appId: 'echolima',
      type: 'capability_intent_failed',
      intentId,
      reason,
      timestamp: Date.now()
    }
    if (Array.isArray(missingSlots)) {
      event.missingSlots = missingSlots.filter(s => typeof s === 'string')
    }

    await getFirestore().collection('events').add(event)
    res.json({ logged: true })
  } catch (err) {
    console.error('telemetry/intent_failed fejl:', err)
    res.status(500).json({ error: 'server_error', message: 'Serverfejl' })
  }
})

// POST /telemetry/intent_ask_triggered
// Body: { intentId: string, askedSlot: string }
//
// Logges når multi-turn ASK-pattern aktiveres (et required slot mangler,
// klient spørger brugeren). Giver indsigt i hvilke slots der ofte mangler
// — kan informere NLU-prompt-forbedringer eller om vi skal lave default-værdier.
router.post('/intent_ask_triggered', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const uid = req.user!.uid
    const { intentId, askedSlot } = req.body

    if (!intentId || typeof intentId !== 'string') {
      res.status(400).json({ error: 'bad_request', message: 'intentId er påkrævet' })
      return
    }
    if (!askedSlot || typeof askedSlot !== 'string') {
      res.status(400).json({ error: 'bad_request', message: 'askedSlot er påkrævet' })
      return
    }

    await getFirestore().collection('events').add({
      uid,
      appId: 'echolima',
      type: 'capability_intent_ask_triggered',
      intentId,
      askedSlot,
      timestamp: Date.now()
    })
    res.json({ logged: true })
  } catch (err) {
    console.error('telemetry/intent_ask_triggered fejl:', err)
    res.status(500).json({ error: 'server_error', message: 'Serverfejl' })
  }
})

export default router
