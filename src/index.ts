import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import dotenv from 'dotenv'
import { initializeApp, cert } from 'firebase-admin/app'

import { generalLimiter } from './middleware/rateLimit'
import authRoutes from './routes/auth'
import tiersRoutes from './routes/tiers'
import usageRoutes from './routes/usage'
import adminRoutes from './routes/admin'
import appsRoutes from './routes/apps'

dotenv.config()

// Firebase Admin initialisering via service account JSON
const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
if (!serviceAccountJson) {
  throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON environment variable is not set')
}
const serviceAccount = JSON.parse(serviceAccountJson)

initializeApp({
  credential: cert(serviceAccount)
})

const app = express()
const PORT = process.env.PORT ?? 3000

// Middleware
app.use(helmet())
app.use(cors())
app.use(express.json())
app.use(generalLimiter)

// Health check
app.get('/health', (_, res) => {
  res.json({ status: 'ok', service: 'echolima-api', timestamp: Date.now() })
})

// Ruter
app.use('/auth', authRoutes)
app.use('/tiers', tiersRoutes)
app.use('/usage', usageRoutes)
app.use('/admin', adminRoutes)
app.use('/apps', appsRoutes)

// 404
app.use((_, res) => {
  res.status(404).json({ error: 'Endpoint ikke fundet' })
})

app.listen(PORT, () => {
  console.log(`EchoLima API kører på port ${PORT}`)
})

export default app