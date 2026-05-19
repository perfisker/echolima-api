import { Router, Response } from 'express'
import { getFirestore } from 'firebase-admin/firestore'
import { AuthRequest } from '../types'
import { verifyToken, isAdmin } from '../middleware/auth'
import { clearNicheCache } from './ai'

const router = Router()

// GET /admin/users — liste alle brugere + tier + månedligt forbrug
router.get('/users', verifyToken, isAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const db = getFirestore()
    const usersSnap = await db.collection('users').get()

    const users = await Promise.all(usersSnap.docs.map(async doc => {
      const data = doc.data()
      const usageSnap = await doc.ref.collection('usage').doc('echolima').get()
      return {
        uid: doc.id,
        email: data.email,
        displayName: data.displayName,
        tierId: data.tierId,
        createdAt: data.createdAt,
        lastSeen: data.lastSeen,
        usage: usageSnap.data() ?? null
      }
    }))

    res.json({ users, total: users.length })
  } catch (err) {
    console.error('admin/users fejl:', err)
    res.status(500).json({ error: 'server_error', message: 'Serverfejl' })
  }
})

// GET /admin/users/:uid — detaljer for én bruger inkl. events
router.get('/users/:uid', verifyToken, isAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const db = getFirestore()
    const uid = req.params.uid

    const [userSnap, usageSnap, eventsSnap] = await Promise.all([
      db.collection('users').doc(uid).get(),
      db.collection('users').doc(uid).collection('usage').doc('echolima').get(),
      db.collection('events')
        .where('uid', '==', uid)
        .orderBy('timestamp', 'desc')
        .limit(50)
        .get()
    ])

    if (!userSnap.exists) {
      res.status(404).json({ error: 'user_not_found', message: 'Bruger ikke fundet' })
      return
    }

    const events = eventsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }))
    const totalCost = events.reduce((sum, e: any) => sum + (e.costUsd ?? 0), 0)

    res.json({
      user: userSnap.data(),
      usage: usageSnap.data() ?? null,
      events,
      totalCostUsd: totalCost
    })
  } catch (err) {
    console.error('admin/users/:uid fejl:', err)
    res.status(500).json({ error: 'server_error', message: 'Serverfejl' })
  }
})

// PATCH /admin/users/:uid/tier — manuel tier-ændring
router.patch('/users/:uid/tier', verifyToken, isAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { tierId } = req.body
    if (!tierId) {
      res.status(400).json({ error: 'missing_tier_id', message: 'tierId mangler' })
      return
    }

    await getFirestore().collection('users').doc(req.params.uid).update({ tierId })
    res.json({ updated: true, tierId })
  } catch (err) {
    console.error('admin/tier fejl:', err)
    res.status(500).json({ error: 'server_error', message: 'Serverfejl' })
  }
})

// GET /admin/revenue — omsætning per tier
router.get('/revenue', verifyToken, isAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const db = getFirestore()
    const usersSnap = await db.collection('users').get()

    // Hardcoded priser pr. tier — bør på sigt læses fra tiers-collection
    // i stedet for at duplikeres her. tier_unlimited har price: -1 i
    // seedTiers (custom enterprise-aftale), men tæller 0 i revenue indtil
    // vi har en faktisk kontraktværdi at lægge på.
    const tierPrices: Record<string, number> = {
      tier_free:      0,
      tier_basic:    49,
      tier_pro:      99,
      tier_unlimited: 0
    }

    const summary: Record<string, { count: number; revenue: number }> = {}
    usersSnap.docs.forEach(doc => {
      const tierId = doc.data().tierId ?? 'tier_free'
      if (!summary[tierId]) summary[tierId] = { count: 0, revenue: 0 }
      summary[tierId].count++
      summary[tierId].revenue += tierPrices[tierId] ?? 0
    })

    const totalRevenue = Object.values(summary).reduce((s, v) => s + v.revenue, 0)
    res.json({ summary, totalRevenueDkk: totalRevenue, totalUsers: usersSnap.size })
  } catch (err) {
    console.error('admin/revenue fejl:', err)
    res.status(500).json({ error: 'server_error', message: 'Serverfejl' })
  }
})

// GET /admin/cost — OpenAI-omkostninger fra events
router.get('/cost', verifyToken, isAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const eventsSnap = await getFirestore().collection('events').get()
    const events = eventsSnap.docs.map(doc => doc.data())

    const totalCost = events.reduce((s, e) => s + (e.costUsd ?? 0), 0)
    const byType: Record<string, number> = {}
    const byUser: Record<string, number> = {}

    events.forEach(e => {
      byType[e.type] = (byType[e.type] ?? 0) + (e.costUsd ?? 0)
      byUser[e.uid] = (byUser[e.uid] ?? 0) + (e.costUsd ?? 0)
    })

    res.json({ totalCostUsd: totalCost, byType, byUser })
  } catch (err) {
    console.error('admin/cost fejl:', err)
    res.status(500).json({ error: 'server_error', message: 'Serverfejl' })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/niche-stats — fordeling af AI-kald per niche
//
// Aggregerer alle aiSummary-events grupperet på nicheId. Bruges af et evt.
// admin-dashboard til at se hvilke niches der bruges mest i praksis.
//
// "unknown"-bucket'en fanger gamle aiSummary-events fra før Step 3-deploy
// (19. maj 2026) hvor nicheId-feltet ikke fandtes. Skal naturligt skrumpe
// over tid efterhånden som ny trafik dominerer.
//
// NB: med mange events bliver dette dyrt — alle events læses i hukommelse.
// Hvis events-collection vokser til >10K, refactor til Firestore aggregation
// queries eller scheduled rollup-job.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/niche-stats', verifyToken, isAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const db = getFirestore()

    // Hent alle aiSummary-events (de eneste med nicheId)
    const eventsSnap = await db.collection('events')
      .where('type', '==', 'aiSummary')
      .get()

    // Aggregér tæller per nicheId
    const counts: Record<string, number> = {}
    eventsSnap.docs.forEach(doc => {
      const nicheId = doc.data().nicheId ?? 'unknown'
      counts[nicheId] = (counts[nicheId] ?? 0) + 1
    })

    const total = eventsSnap.size

    // Hent displayName fra niches-collection (én batch read)
    const nichesSnap = await db.collection('niches').get()
    const displayNames: Record<string, string> = {}
    nichesSnap.docs.forEach(doc => {
      const data = doc.data()
      displayNames[doc.id] = data.displayName?.da ?? doc.id
    })

    // Byg stats-array sorteret efter count desc
    const stats = Object.entries(counts)
      .map(([nicheId, count]) => ({
        nicheId,
        displayName: displayNames[nicheId] ?? nicheId,
        count,
        pct: total > 0 ? Math.round((count / total) * 100) : 0
      }))
      .sort((a, b) => b.count - a.count)

    res.json({
      period: 'all-time',
      stats,
      total
    })
  } catch (err) {
    console.error('admin/niche-stats fejl:', err)
    res.status(500).json({ error: 'server_error', message: 'Serverfejl' })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/niches/invalidate-cache — tving niche-cache refresh
//
// Body: { nicheId?: string }
//   - nicheId udeladt → ryd HELE cache (alle niches refreshes ved næste read)
//   - nicheId angivet → ryd kun den specifikke niche fra cache
//
// Brug-case: når du har redigeret en niche-prompt direkte i Firestore Console
// og vil have ændringen til at slå igennem inden den indbyggede 5-min TTL
// udløber. Uden dette endpoint skal du vente op til 5 minutter.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/niches/invalidate-cache', verifyToken, isAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { nicheId } = req.body
    if (nicheId !== undefined && typeof nicheId !== 'string') {
      res.status(400).json({
        error: 'invalid_niche_id',
        message: 'nicheId skal være en string eller udeladt'
      })
      return
    }

    clearNicheCache(nicheId)
    res.json({ cleared: nicheId ?? 'all' })
  } catch (err) {
    console.error('admin/niches/invalidate-cache fejl:', err)
    res.status(500).json({ error: 'server_error', message: 'Serverfejl' })
  }
})

export default router
