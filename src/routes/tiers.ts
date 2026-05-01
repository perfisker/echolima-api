import { Router, Response } from 'express'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'
import { AuthRequest } from '../types'
import { verifyToken, isAdmin } from '../middleware/auth'

const router = Router()

// GET /tiers?appId=echolima — hent alle tiers for en app (caches i appen)
router.get('/', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const appId = (req.query.appId as string) ?? 'echolima'
    const snap = await getFirestore()
      .collection('tiers')
      .where('appId', '==', appId)
      .get()

    const tiers = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }))
    res.json({ tiers })
  } catch (err) {
    console.error('tiers fejl:', err)
    res.status(500).json({ error: 'Serverfejl' })
  }
})

// GET /tiers/:tierId — hent specifik tier
router.get('/:tierId', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const appId = (req.query.appId as string) ?? 'echolima'
    const snap = await getFirestore()
      .collection('tiers')
      .doc(`${appId}_${req.params.tierId}`)
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

// POST /tiers/check — tjek om bruger må udføre en handling
router.post('/check', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const uid = req.user!.uid
    const { action, appId = 'echolima' } = req.body
    // action: 'transcription' | 'visionCall' | 'aiSummary'

    const db = getFirestore()
    const userSnap = await db.collection('users').doc(uid).get()
    const tierId = userSnap.data()?.tierId ?? 'free'

    const [tierSnap, usageSnap] = await Promise.all([
      db.collection('tiers').doc(`${appId}_${tierId}`).get(),
      db.collection('users').doc(uid).collection('usage').doc(appId).get()
    ])

    const limits = tierSnap.data()?.limits ?? {}
    const usage = usageSnap.data() ?? {}

    // Map action til felt-navne
    const fieldMap: Record<string, string> = {
      transcription: 'transcriptions',
      visionCall: 'visionCalls',
      aiSummary: 'aiSummaries'
    }
    const field = fieldMap[action]
    if (!field) {
      res.status(400).json({ error: 'Ukendt action' })
      return
    }

    const limit = limits[field] ?? 0
    const used = usage[field] ?? 0

    // -1 = ubegrænset (Pro/Enterprise)
    const allowed = limit === -1 || used < limit

    res.json({
      allowed,
      used,
      limit,
      tierId
    })
  } catch (err) {
    console.error('tiers/check fejl:', err)
    res.status(500).json({ error: 'Serverfejl' })
  }
})

export default router
