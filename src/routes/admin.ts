import { Router, Response } from 'express'
import { getFirestore } from 'firebase-admin/firestore'
import { AuthRequest } from '../types'
import { verifyToken, isAdmin } from '../middleware/auth'

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
    res.status(500).json({ error: 'Serverfejl' })
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
      res.status(404).json({ error: 'Bruger ikke fundet' })
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
    res.status(500).json({ error: 'Serverfejl' })
  }
})

// PATCH /admin/users/:uid/tier — manuel tier-ændring
router.patch('/users/:uid/tier', verifyToken, isAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { tierId } = req.body
    if (!tierId) {
      res.status(400).json({ error: 'tierId mangler' })
      return
    }

    await getFirestore().collection('users').doc(req.params.uid).update({ tierId })
    res.json({ updated: true, tierId })
  } catch (err) {
    console.error('admin/tier fejl:', err)
    res.status(500).json({ error: 'Serverfejl' })
  }
})

// GET /admin/revenue — omsætning per tier
router.get('/revenue', verifyToken, isAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const db = getFirestore()
    const usersSnap = await db.collection('users').get()

    const tierPrices: Record<string, number> = {
      free: 0,
      casual: 49,
      pro: 149,
      enterprise: 499
    }

    const summary: Record<string, { count: number; revenue: number }> = {}
    usersSnap.docs.forEach(doc => {
      const tierId = doc.data().tierId ?? 'free'
      if (!summary[tierId]) summary[tierId] = { count: 0, revenue: 0 }
      summary[tierId].count++
      summary[tierId].revenue += tierPrices[tierId] ?? 0
    })

    const totalRevenue = Object.values(summary).reduce((s, v) => s + v.revenue, 0)
    res.json({ summary, totalRevenueDkk: totalRevenue, totalUsers: usersSnap.size })
  } catch (err) {
    console.error('admin/revenue fejl:', err)
    res.status(500).json({ error: 'Serverfejl' })
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
    res.status(500).json({ error: 'Serverfejl' })
  }
})

export default router
