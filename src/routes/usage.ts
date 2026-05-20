import { Router, Response } from 'express'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'
import { AuthRequest } from '../types'
import { verifyToken, isAdmin } from '../middleware/auth'

const router = Router()

// POST /usage/record — registrer at en note er færdig-behandlet
//
// Body: { action: 'voiceNote' | 'cameraNote', appId?: string }
//
// Kaldes ÉN GANG per note-completion fra klienten — ikke længere én gang per
// underliggende AI-kald. Modellen er forenklet fra tre tællere til to:
//
//   action='voiceNote'  → users/{uid}/usage/{appId}.voiceNotes  += 1
//   action='cameraNote' → users/{uid}/usage/{appId}.cameraNotes += 1
//
// Events-logging i events-collection sker direkte fra /ai/analyze (for
// aiSummary med nicheId) og /ai/vision (for visionCall). /usage/record
// fokuserer udelukkende på den bruger-vendte counter-increment.
router.post('/record', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const uid = req.user!.uid
    const { action, appId = 'echolima' } = req.body

    const fieldMap: Record<string, string> = {
      voiceNote:  'voiceNotes',
      cameraNote: 'cameraNotes'
    }
    const field = fieldMap[action]
    if (!field) {
      res.status(400).json({
        error: 'unknown_action',
        message: 'Ukendt action — forventet voiceNote eller cameraNote'
      })
      return
    }

    const db = getFirestore()
    const usageRef = db.collection('users').doc(uid).collection('usage').doc(appId)

    // Bruger set+merge så vi ikke fejler hvis usage-doc'et endnu ikke findes
    // (kan ske ved første note efter signup hvis /auth/sync ikke har kørt endnu).
    await usageRef.set(
      { [field]: FieldValue.increment(1) },
      { merge: true }
    )

    res.json({ recorded: true })
  } catch (err) {
    console.error('usage/record fejl:', err)
    res.status(500).json({ error: 'server_error', message: 'Serverfejl' })
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
    res.status(500).json({ error: 'server_error', message: 'Serverfejl' })
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

      // Batch-opdater usage for denne gruppe.
      // NB: storageBytes nulstilles IKKE — det er aktuel-state, ikke en
      // månedlig counter. Det vedligeholdes via Cloud Functions
      // (onStorageUpload/onStorageDelete) og reconcileStorageUsage.
      const batch = db.batch()
      snap.docs.forEach(userDoc => {
        const usageRef = db.collection('users').doc(userDoc.id)
          .collection('usage').doc(appId)
        batch.update(usageRef, {
          voiceNotes:  0,
          cameraNotes: 0,
          resetAt:     Date.now()
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
    res.status(500).json({ error: 'server_error', message: 'Serverfejl' })
  }
})

export default router