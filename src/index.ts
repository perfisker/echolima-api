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
import aiRoutes from './routes/ai'
import emailRoutes from './routes/email'
import stripeRoutes from './routes/stripe'

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

// Stripe webhook kræver raw body — registreres FØR express.json()
app.use('/stripe/webhook', express.raw({ type: 'application/json' }))

app.use(express.json({ limit: '10mb' }))
app.use(generalLimiter)

// Health check
app.get('/health', (_, res) => {
  res.json({ status: 'ok', service: 'echolima-api', timestamp: Date.now() })
})

// Stripe redirect sider
app.get('/payment/success', (_, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Betaling gennemført</title>
  <style>body{font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0a0a0a;color:#fff;}
  h1{font-size:2rem;margin-bottom:8px;}p{color:#aaa;text-align:center;}</style></head>
  <body><div style="font-size:3rem">✅</div><h1>Betaling gennemført</h1>
  <p>Dit abonnement er aktiveret.<br>Du kan nu lukke denne fane og vende tilbage til EchoLima.</p></body></html>`)
})

app.get('/payment/cancel', (_, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Betaling annulleret</title>
  <style>body{font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0a0a0a;color:#fff;}
  h1{font-size:2rem;margin-bottom:8px;}p{color:#aaa;text-align:center;}</style></head>
  <body><div style="font-size:3rem">❌</div><h1>Betaling annulleret</h1>
  <p>Betalingen blev ikke gennemført.<br>Du kan lukke denne fane og prøve igen fra EchoLima.</p></body></html>`)
})

// Ruter
app.use('/auth', authRoutes)
app.use('/tiers', tiersRoutes)
app.use('/usage', usageRoutes)
app.use('/admin', adminRoutes)
app.use('/apps', appsRoutes)
app.use('/ai', aiRoutes)
app.use('/email', emailRoutes)
app.use('/stripe', stripeRoutes)

// 404
app.use((_, res) => {
  res.status(404).json({ error: 'Endpoint ikke fundet' })
})

app.listen(PORT, () => {
  console.log(`EchoLima API kører på port ${PORT}`)
})

export default app
