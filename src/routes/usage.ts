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
      visionCall:    'visionCalls',
      aiSummary:     'aiSummaries'
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
// Behandler brugere i batches af 500 for at undgå timeout ved mange brugere
router.post('/reset', verifyToken, isAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const appId = (req.body.appId as string) ?? 'echolima'
    const db = getFirestore()

    let processed = 0
    let lastDoc: FirebaseFirestore.QueryDocumentSnapshot | null = null

    while (true) {
      // Hent næste batch af brugere
      let query = db.collection('users').limit(500) as FirebaseFirestore.Query
      if (lastDoc) {
        query = query.startAfter(lastDoc)
      }

      const snap = await query.get()
      if (snap.empty) break

      // Batch-opdater usage for denne gruppe
      const batch = db.batch()
      snap.docs.forEach(userDoc => {
        const usageRef = db.collection('users').doc(userDoc.id)
          .collection('usage').doc(appId)
        batch.update(usageRef, {
          transcriptions: 0,
          visionCalls:    0,
          aiSummaries:    0,
          resetAt:        Date.now()
        })
      })
      await batch.commit()

      processed += snap.size
      lastDoc = snap.docs[snap.docs.length - 1]

      // Stop hvis vi har hentet færre end limit — vi er nået til slutningen
      if (snap.size < 500) break
    }

    res.json({ reset: true, users: processed })
  } catch (err) {
    console.error('usage/reset fejl:', err)
    res.status(500).json({ error: 'Serverfejl' })
  }
})

export default router