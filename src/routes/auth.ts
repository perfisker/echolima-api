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
        tierId: 'tier_free',
        defaultNiche: 'generel',
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
      res.json({ created: true, tierId: 'tier_free' })
    } else {
      // Backfill + migrér defaultNiche-feltet på eksisterende user-docs:
      //   - manglende felt        → sættes til 'generel' (intro Step 5, 19. maj)
      //   - lagret som 'vvs'      → migreres til 'haandvaerker' (rename 20. maj)
      // Brugere undgår dermed 403 niche_tier_required ved næste AI-kald.
      const updates: Record<string, any> = { lastSeen: Date.now() }
      const currentNiche = snap.data()?.defaultNiche
      if (!currentNiche) {
        updates.defaultNiche = 'generel'
      } else if (currentNiche === 'vvs') {
        updates.defaultNiche = 'haandvaerker'
      }
      await userRef.update(updates)
      res.json({ created: false, tierId: snap.data()?.tierId ?? 'tier_free' })
    }
  } catch (err) {
    console.error('auth/sync fejl:', err)
    res.status(500).json({ error: 'server_error', message: 'Serverfejl' })
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
      res.status(404).json({ error: 'user_not_found', message: 'Bruger ikke fundet' })
      return
    }
    const tierId = userSnap.data()?.tierId ?? 'tier_free'
    // NB: tiers-collection bruger doc-IDs uden prefix (matcher seedTiers.ts og
    // resten af codebase'en, fx routes/tiers.ts). Tidligere stod der her
    // `echolima_${tierId}` hvilket altid resulterede i tierSnap.exists=false,
    // så GET /auth/me returnerede tier: null for alle brugere.
    const tierSnap = await db.collection('tiers').doc(tierId).get()
    res.json({ user: userSnap.data(), tier: tierSnap.data() ?? null, usage: usageSnap.data() ?? null })
  } catch (err) {
    console.error('auth/me fejl:', err)
    res.status(500).json({ error: 'server_error', message: 'Serverfejl' })
  }
})

// PATCH /auth/me — opdater locale, displayName eller defaultNiche
router.patch('/me', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const uid = req.user!.uid
    const { locale, displayName, defaultNiche } = req.body
    const updates: Record<string, string> = {}
    if (locale) updates.locale = locale
    if (displayName) updates.displayName = displayName

    // defaultNiche-validering: skal være en eksisterende AKTIV niche.
    // Vi henter direkte fra Firestore (ikke via getNiche()-cache i ai.ts)
    // for at undgå cross-route imports. PATCH er sjælden så cache-besparelsen
    // er minimal.
    if (defaultNiche !== undefined) {
      if (typeof defaultNiche !== 'string') {
        res.status(400).json({
          error: 'invalid_default_niche',
          message: 'defaultNiche skal være en string'
        })
        return
      }

      // Legacy-alias: ældre klient-versioner sender stadig "vvs". Konvertér
      // stille til "haandvaerker" inden validering (rename 20. maj 2026).
      const resolvedNiche = defaultNiche === 'vvs' ? 'haandvaerker' : defaultNiche

      const db = getFirestore()
      const nicheSnap = await db.collection('niches').doc(resolvedNiche).get()
      if (!nicheSnap.exists || nicheSnap.data()?.isActive !== true) {
        res.status(400).json({
          error: 'unknown_niche',
          message: `Niche '${resolvedNiche}' findes ikke eller er deaktiveret`
        })
        return
      }
      updates.defaultNiche = resolvedNiche
    }

    await getFirestore().collection('users').doc(uid).update(updates)
    res.json({ updated: true })
  } catch (err) {
    console.error('auth/patch fejl:', err)
    res.status(500).json({ error: 'server_error', message: 'Serverfejl' })
  }
})

export default router
