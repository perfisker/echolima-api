import { Router, Response } from 'express'
import { getFirestore } from 'firebase-admin/firestore'
import { AuthRequest } from '../types'
import { verifyToken } from '../middleware/auth'
import { authLimiter } from '../middleware/rateLimit'

const router = Router()

// POST /auth/sync — opret/opdater bruger efter Google Sign-In
router.post('/sync', authLimiter, verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!
    const db = getFirestore()
    const userRef = db.collection('users').doc(user.uid)
    const snap = await userRef.get()

    if (!snap.exists) {
      await userRef.set({
        uid: user.uid,
        email: user.email ?? '',
        displayName: user.name ?? '',
        photoURL: user.picture ?? '',
        tierId: 'free',
        createdAt: Date.now(),
        lastSeen: Date.now(),
        locale: 'da'
      })
      await userRef.collection('usage').doc('echolima').set({
        transcriptions: 0,
        visionCalls: 0,
        aiSummaries: 0,
        storageBytes: 0,
        resetAt: Date.now()
      })
      res.json({ created: true, tierId: 'free' })
    } else {
      await userRef.update({ lastSeen: Date.now() })
      res.json({ created: false, tierId: snap.data()?.tierId ?? 'free' })
    }
  } catch (err) {
    console.error('auth/sync fejl:', err)
    res.status(500).json({ error: 'Serverfejl' })
  }
})

// GET /auth/me — hent profil + tier + usage
router.get('/me', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const uid = req.user!.uid
    const db = getFirestore()
    const [userSnap, usageSnap] = await Promise.all([
      db.collection('users').doc(uid).get(),
      db.collection('users').doc(uid).collection('usage').doc('echolima').get()
    ])
    if (!userSnap.exists) {
      res.status(404).json({ error: 'Bruger ikke fundet' })
      return
    }
    const tierId = userSnap.data()?.tierId ?? 'free'
    const tierSnap = await db.collection('tiers').doc(`echolima_${tierId}`).get()
    res.json({ user: userSnap.data(), tier: tierSnap.data() ?? null, usage: usageSnap.data() ?? null })
  } catch (err) {
    console.error('auth/me fejl:', err)
    res.status(500).json({ error: 'Serverfejl' })
  }
})

// PATCH /auth/me — opdater locale eller displayName
router.patch('/me', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const uid = req.user!.uid
    const { locale, displayName } = req.body
    const updates: Record<string, string> = {}
    if (locale) updates.locale = locale
    if (displayName) updates.displayName = displayName
    await getFirestore().collection('users').doc(uid).update(updates)
    res.json({ updated: true })
  } catch (err) {
    console.error('auth/patch fejl:', err)
    res.status(500).json({ error: 'Serverfejl' })
  }
})

export default router
