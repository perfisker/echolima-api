import { Response, NextFunction } from 'express'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'
import { AuthRequest } from '../types'

// Verificer Firebase ID token på alle beskyttede ruter
export async function verifyToken(req: AuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Manglende autorisation' })
    return
  }

  const token = authHeader.split('Bearer ')[1]
  try {
    const decoded = await getAuth().verifyIdToken(token)
    req.user = decoded
    next()
  } catch {
    res.status(401).json({ error: 'Ugyldigt token' })
  }
}

// Kun admin-brugere (tjek email mod ADMIN_EMAIL env)
export async function isAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.user) {
    res.status(401).json({ error: 'Ikke autoriseret' })
    return
  }

  const adminEmail = process.env.ADMIN_EMAIL
  if (req.user.email !== adminEmail) {
    res.status(403).json({ error: 'Kun admins har adgang' })
    return
  }

  next()
}

// Hjælpefunktion: hent brugerens tier og usage fra Firestore
//
// NB: tiers-collection bruger flade doc-IDs uden app-prefix (fx "tier_basic",
// ikke "echolima_tier_basic"). Det blev fixet 15. maj 2026 i routes/auth.ts
// L60-bug, men samme mønster lurede her uden at være opdaget. Helperen er pt.
// ikke aktivt brugt af nogen route, men er nu correct hvis den senere tages
// i brug.
export async function getUserTierAndUsage(uid: string, appId: string) {
  const db = getFirestore()
  const userSnap = await db.collection('users').doc(uid).get()
  const tierId = userSnap.data()?.tierId ?? 'tier_free'

  const tierSnap = await db.collection('tiers').doc(tierId).get()
  const usageSnap = await db.collection('users').doc(uid)
    .collection('usage').doc(appId).get()

  return {
    tierId,
    tier: tierSnap.data(),
    usage: usageSnap.data()
  }
}
