import { Router, Response } from 'express'
import { getFirestore } from 'firebase-admin/firestore'
import { AuthRequest } from '../types'
import { verifyToken, isAdmin } from '../middleware/auth'

const router = Router()

// GET /apps — liste alle apps [admin]
router.get('/', verifyToken, isAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const snap = await getFirestore().collection('apps').get()
    const apps = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }))
    res.json({ apps })
  } catch (err) {
    res.status(500).json({ error: 'Serverfejl' })
  }
})

// POST /apps — registrer ny app [admin]
router.post('/', verifyToken, isAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { name, bundleId, platform, version } = req.body
    const ref = await getFirestore().collection('apps').add({
      name, bundleId, platform, version,
      isActive: true,
      createdAt: Date.now()
    })
    res.json({ created: true, id: ref.id })
  } catch (err) {
    res.status(500).json({ error: 'Serverfejl' })
  }
})

// PATCH /apps/:appId — opdater version eller isActive [admin]
router.patch('/:appId', verifyToken, isAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { version, isActive } = req.body
    const updates: Record<string, any> = {}
    if (version !== undefined) updates.version = version
    if (isActive !== undefined) updates.isActive = isActive

    await getFirestore().collection('apps').doc(req.params.appId).update(updates)
    res.json({ updated: true })
  } catch (err) {
    res.status(500).json({ error: 'Serverfejl' })
  }
})

export default router
