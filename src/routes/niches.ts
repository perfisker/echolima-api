import { Router, Response } from 'express'
import { getFirestore } from 'firebase-admin/firestore'
import { AuthRequest, NicheDoc, NichePublic } from '../types'
import { verifyToken } from '../middleware/auth'

const router = Router()

// ─────────────────────────────────────────────────────────────────────────────
// Tier-helpers
//
// TODO: konsolidér med samme logik der ligger i routes/ai.ts. Pt. duplikeret
// for at undgå at refactore en route-fil mens vi tester en anden. Når
// både ai.ts og niches.ts er stabile, ekstrahér til src/helpers/tier.ts.
// ─────────────────────────────────────────────────────────────────────────────

const TIER_ORDER = ['tier_free', 'tier_basic', 'tier_pro', 'tier_unlimited']

function tierMeetsMinimum(userTier: string, minTier: string): boolean {
  const userIdx = TIER_ORDER.indexOf(userTier)
  const minIdx = TIER_ORDER.indexOf(minTier)
  if (userIdx === -1 || minIdx === -1) return false
  return userIdx >= minIdx
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /niches?appId=echolima
//
// Returnerer aktive niches der er:
//   - markeret isActive: true
//   - har det forespurgte appId i deres appIds-array
//   - har minTier ≤ brugerens nuværende tier
//
// Sorteret efter order-feltet. EKSKLUDERER prompt-feltet bevidst — det er
// backend-only IP og må ikke sendes til klienten.
//
// appId-parameter er optional (default 'echolima'). Når gæsteliste-app
// senere skal hente sine egne niches, kalder den med ?appId=gaesteliste.
// ─────────────────────────────────────────────────────────────────────────────

router.get('/', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const uid = req.user!.uid
    const appId = (req.query.appId as string) ?? 'echolima'

    const db = getFirestore()

    // Hent brugerens tier (vi tier-filtrerer i memory bagefter)
    const userSnap = await db.collection('users').doc(uid).get()
    const userTier = userSnap.data()?.tierId ?? 'tier_free'

    // Query aktive niches for det specifikke app.
    //
    // Bevidst INGEN .orderBy() i query — kombinationen af to where-clauses
    // + orderBy ville kræve et composite index i Firestore. Vi sorterer i
    // memory bagefter. Med få niches pr. app (forventet <20 selv at fuld
    // skala) er det essentielt gratis.
    const snap = await db.collection('niches')
      .where('isActive', '==', true)
      .where('appIds', 'array-contains', appId)
      .get()

    const niches: NichePublic[] = snap.docs
      .map(doc => {
        const data = doc.data() as NicheDoc
        data.id = doc.id  // sikrer at .id matcher doc-reference uanset seed-data
        return data
      })
      .filter(niche => tierMeetsMinimum(userTier, niche.minTier))
      .sort((a, b) => a.order - b.order)
      .map(niche => ({
        // Eksplicit projektion: KUN disse felter, INGEN prompt
        id: niche.id,
        displayName: niche.displayName,
        description: niche.description,
        minTier: niche.minTier,
        order: niche.order
      }))

    res.json({ niches })
  } catch (err) {
    console.error('niches fejl:', err)
    res.status(500).json({ error: 'server_error', message: 'Serverfejl' })
  }
})

export default router
