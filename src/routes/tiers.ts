import { Router, Request, Response } from 'express'
import { getFirestore } from 'firebase-admin/firestore'
import { AuthRequest } from '../types'
import { verifyToken } from '../middleware/auth'

const router = Router()

// GET /tiers — hent alle tiers (offentlig)
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
    res.status(500).json({ error: 'Serverfejl' })
  }
})

// GET /tiers/usage — hent forbrug og grænser for aktuel bruger (kræver auth)
// Skal ligge FØR /:tierId så "usage" ikke matches som tierId
router.get('/usage', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const uid = req.user!.uid
    const db = getFirestore()

    const userSnap = await db.collection('users').doc(uid).get()
    const tierId = userSnap.data()?.tierId ?? 'foxtrot'

    const [tierSnap, usageSnap] = await Promise.all([
      db.collection('tiers').doc(tierId).get(),
      db.collection('users').doc(uid).collection('usage').doc('echolima').get()
    ])

    const tier  = tierSnap.data()  ?? {}
    const usage = usageSnap.data() ?? {}

    res.json({
      tierId,
      transcriptions: { used: usage.transcriptions ?? 0, limit: tier.transcriptionsPerMonth ?? 0 },
      aiSummaries:    { used: usage.aiSummaries    ?? 0, limit: tier.aiSummariesPerMonth    ?? 0 },
      visionCalls:    { used: usage.visionCalls    ?? 0, limit: tier.visionCallsPerMonth    ?? 0 },
      resetAt: usage.resetAt ?? null
    })
  } catch (err) {
    console.error('tiers/usage fejl:', err)
    res.status(500).json({ error: 'Serverfejl' })
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
      res.status(404).json({ error: 'Tier ikke fundet' })
      return
    }
    res.json({ tier: { id: snap.id, ...snap.data() } })
  } catch (err) {
    console.error('tiers/:id fejl:', err)
    res.status(500).json({ error: 'Serverfejl' })
  }
})

// POST /tiers/check — tjek om bruger må udføre en handling (kræver auth)
router.post('/check', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const uid = req.user!.uid
    const { action } = req.body

    const db = getFirestore()
    const userSnap = await db.collection('users').doc(uid).get()
    const tierId = userSnap.data()?.tierId ?? 'foxtrot'

    const [tierSnap, usageSnap] = await Promise.all([
      db.collection('tiers').doc(tierId).get(),
      db.collection('users').doc(uid).collection('usage').doc('echolima').get()
    ])

    const tier = tierSnap.data() ?? {}
    const usage = usageSnap.data() ?? {}

    const actionMap: Record<string, { tierField: string; usageField: string }> = {
      transcription: { tierField: 'transcriptionsPerMonth', usageField: 'transcriptions' },
      visionCall:   { tierField: 'visionCallsPerMonth',    usageField: 'visionCalls' },
      aiSummary:    { tierField: 'aiSummariesPerMonth',    usageField: 'aiSummaries' }
    }
    const mapping = actionMap[action]
    if (!mapping) {
      res.status(400).json({ error: 'Ukendt action' })
      return
    }

    const limit = tier[mapping.tierField] ?? 0
    const used  = usage[mapping.usageField] ?? 0

    // -1 betyder ubegrænset
    const allowed = limit === -1 || used < limit

    res.json({ allowed, used, limit, tierId })
  } catch (err) {
    console.error('tiers/check fejl:', err)
    res.status(500).json({ error: 'Serverfejl' })
  }
})

export default router
