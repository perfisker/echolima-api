import { Router, Response } from 'express'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'
import { AuthRequest } from '../types'
import { verifyToken, isAdmin } from '../middleware/auth'

const router = Router()

// POST /usage/record — registrer ét AI-kald
router.post('/record', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const uid = req.user!.uid
    const { action, appId = 'echolima', tokens = 0, costUsd = 0 } = req.body
    // action: 'transcription' | 'visionCall' | 'aiSummary'

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

    const db = getFirestore()
    const batch = db.batch()

    // Inkrementer usage-tæller
    const usageRef = db.collection('users').doc(uid).collection('usage').doc(appId)
    batch.update(usageRef, { [field]: FieldValue.increment(1) })

    // Log event til admin-analyse
    const eventRef = db.collection('events').doc()
    batch.set(eventRef, {
      uid,
      appId,
      type: action,
      timestamp: Date.now(),
      tokens,
      costUsd
    })

    await batch.commit()
    res.json({ recorded: true })
  } catch (err) {
    console.error('usage/record fejl:', err)
    res.status(500).json({ error: 'Serverfejl' })
  }
})

// GET /usage/me — hent eget forbrug denne måned
router.get('/me', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const uid = req.user!.uid
    const appId = (req.query.appId as string) ?? 'echolima'
    const snap = await getFirestore()
      .collection('users').doc(uid)
      .collection('usage').doc(appId)
      .get()

    res.json({ usage: snap.data() ?? null })
  } catch (err) {
    console.error('usage/me fejl:', err)
    res.status(500).json({ error: 'Serverfejl' })
  }
})

// POST /usage/reset — nulstil alle usage-counters (månedlig cron) [admin]
router.post('/reset', verifyToken, isAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const appId = (req.body.appId as string) ?? 'echolima'
    const db = getFirestore()
    const usersSnap = await db.collection('users').get()

    const batch = db.batch()
    usersSnap.docs.forEach(userDoc => {
      const usageRef = db.collection('users').doc(userDoc.id)
        .collection('usage').doc(appId)
      batch.update(usageRef, {
        transcriptions: 0,
        visionCalls: 0,
        aiSummaries: 0,
        resetAt: Date.now()
      })
    })

    await batch.commit()
    res.json({ reset: true, users: usersSnap.size })
  } catch (err) {
    console.error('usage/reset fejl:', err)
    res.status(500).json({ error: 'Serverfejl' })
  }
})

export default router
