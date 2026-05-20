import { Router, Request, Response } from 'express'
import { getFirestore } from 'firebase-admin/firestore'
import { AuthRequest } from '../types'
import { verifyToken } from '../middleware/auth'

const router = Router()

// ─────────────────────────────────────────────────────────────────────────────
// In-memory tier cache
// Tier-data ændres sjældent — cache i 5 minutter for at undgå
// Firestore-læsning på hvert eneste AI-kald ved mange samtidige brugere.
// ─────────────────────────────────────────────────────────────────────────────

interface CacheEntry {
  data: Record<string, any>
  expiresAt: number
}

const tierCache = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 5 * 60 * 1000  // 5 minutter

async function getCachedTier(tierId: string): Promise<Record<string, any>> {
  const cached = tierCache.get(tierId)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data
  }

  const snap = await getFirestore().collection('tiers').doc(tierId).get()
  const data = snap.data() ?? {}
  tierCache.set(tierId, { data, expiresAt: Date.now() + CACHE_TTL_MS })
  return data
}

// Bruges af admin-routes til at tvinge cache-rydning når tier opdateres
export function clearTierCache(tierId?: string) {
  if (tierId) {
    tierCache.delete(tierId)
  } else {
    tierCache.clear()
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

// GET /tiers — hent alle tiers (offentlig)
// Returnerer displayName + description automatisk via {...doc.data()}-spread.
router.get('/', async (req: Request, res: Response) => {
  try {
    const snap = await getFirestore()
      .collection('tiers')
      .orderBy('order')
      .get()
    const tiers = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }))
    res.json({ tiers })
  } catch (err) {
    console.error('tiers fejl:', err)
    res.status(500).json({ error: 'server_error', message: 'Serverfejl' })
  }
})

// GET /tiers/usage — hent forbrug og grænser for aktuel bruger (kræver auth)
// Skal ligge FØR /:tierId så "usage" ikke matches som tierId
router.get('/usage', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const uid = req.user!.uid
    const db = getFirestore()

    const userSnap = await db.collection('users').doc(uid).get()
    const tierId = userSnap.data()?.tierId ?? 'tier_free'

    // Brug cache til tier-data — undgå Firestore-læsning på hvert kald
    const [tier, usageSnap] = await Promise.all([
      getCachedTier(tierId),
      db.collection('users').doc(uid).collection('usage').doc('echolima').get()
    ])
    const usage = usageSnap.data() ?? {}

    // storageMB i tier-doc'et er angivet i MB; konverter til bytes så app'en
    // direkte kan vise progress mod faktiske usedBytes uden konvertering.
    // -1 (ubegrænset) propagerer som -1 og lader app'en skjule/erstatte meteren.
    const storageLimitBytes = tier.storageMB === -1
      ? -1
      : (tier.storageMB ?? 0) * 1024 * 1024

    res.json({
      tierId,
      voiceNotes:  { used: usage.voiceNotes  ?? 0, limit: tier.voiceNotesPerMonth  ?? 0 },
      cameraNotes: { used: usage.cameraNotes ?? 0, limit: tier.cameraNotesPerMonth ?? 0 },
      storage:     { usedBytes: usage.storageBytes ?? 0, limitBytes: storageLimitBytes },
      resetAt: usage.resetAt ?? null
    })
  } catch (err) {
    console.error('tiers/usage fejl:', err)
    res.status(500).json({ error: 'server_error', message: 'Serverfejl' })
  }
})

// GET /tiers/:tierId — hent specifik tier (offentlig)
router.get('/:tierId', async (req: Request, res: Response) => {
  try {
    const snap = await getFirestore()
      .collection('tiers')
      .doc(req.params.tierId)
      .get()
    if (!snap.exists) {
      res.status(404).json({ error: 'tier_not_found', message: 'Tier ikke fundet' })
      return
    }
    res.json({ tier: { id: snap.id, ...snap.data() } })
  } catch (err) {
    console.error('tiers/:id fejl:', err)
    res.status(500).json({ error: 'server_error', message: 'Serverfejl' })
  }
})

// POST /tiers/check — tjek om bruger må udføre en handling (kræver auth)
router.post('/check', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const uid = req.user!.uid
    const { action } = req.body
    const db = getFirestore()

    const userSnap = await db.collection('users').doc(uid).get()
    const tierId = userSnap.data()?.tierId ?? 'tier_free'

    // Brug cache til tier-data
    const [tier, usageSnap] = await Promise.all([
      getCachedTier(tierId),
      db.collection('users').doc(uid).collection('usage').doc('echolima').get()
    ])
    const usage = usageSnap.data() ?? {}

    // User-facing action types (counter-refactor 20. maj 2026):
    //   voiceNote  = note uden billede (intern: transcribe + analyze)
    //   cameraNote = note med billede(r) (intern: transcribe + describe-images + analyze)
    // Backend's events-collection logger stadig de individuelle AI-kald
    // (transcription/aiSummary/visionCall) til cost-analyse i /admin/cost,
    // men /tiers/check og /usage/record bruger kun de aggregerede counters.
    const actionMap: Record<string, { tierField: string; usageField: string }> = {
      voiceNote:  { tierField: 'voiceNotesPerMonth',  usageField: 'voiceNotes' },
      cameraNote: { tierField: 'cameraNotesPerMonth', usageField: 'cameraNotes' }
    }

    const mapping = actionMap[action]
    if (!mapping) {
      res.status(400).json({ error: 'unknown_action', message: 'Ukendt action' })
      return
    }

    const limit = tier[mapping.tierField] ?? 0
    const used  = usage[mapping.usageField] ?? 0

    // -1 betyder ubegrænset
    const allowed = limit === -1 || used < limit
    res.json({ allowed, used, limit, tierId })
  } catch (err) {
    console.error('tiers/check fejl:', err)
    res.status(500).json({ error: 'server_error', message: 'Serverfejl' })
  }
})

export default router
