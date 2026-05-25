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
import nichesRoutes from './routes/niches'
import telemetryRoutes from './routes/telemetry'

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

// CRITICAL: Render kører bag deres egen reverse-proxy der tilføjer
// X-Forwarded-For-header. Uden 'trust proxy' kan express-rate-limit ikke
// identificere klienter via deres reelle IP — den bruger i stedet socket-IP
// (Render's interne proxy-IP), så ALLE requests deler samme rate-limit-bucket.
// Resultat: Render's health-check rammer 429 inden for få minutter, instance
// markeres som unhealthy, processen restartes — og webhooks der lander mens
// processen er nede får 502.
// Værdien '1' = stol på første proxy-hop (Render's edge). Brug ikke 'true' der
// stoler på vilkårligt antal hops og åbner for X-Forwarded-For-spoofing.
app.set('trust proxy', 1)

const PORT = process.env.PORT ?? 3000

// Middleware
app.use(helmet())

// ─── CORS-allowlist ──────────────────────────────────────────────────────────
// Eksplicit liste over web-origins der må kalde dette API. Android-klienten
// går via Retrofit/OkHttp og sender ikke Origin-header — derfor påvirkes
// mobile-traffic ikke af CORS. Listen styrer kun browser-requests.
//
// Historik:
//   - Tidligere: app.use(cors()) (helt åbent — allow-all-origins)
//   - 23. maj 2026: strammet op til eksplicit allowlist + aidkick.app
//     tilføjet ifm. web-rebrand (Web-WS launch-prep)
//
// Origins der må kalde:
//   - https://aidkick.app                     → primær web-URL (rebrandet)
//   - https://www.aidkick.app                 → www-redirect (Firebase Hosting)
//   - https://echolima-769c7.web.app          → Firebase default-URL (backup)
//   - https://echolima-769c7.firebaseapp.com  → Firebase alt-URL (backup)
//   - http://localhost:*                      → lokal udvikling (alle porte)
//
// Requests UDEN Origin-header (server-to-server, mobile apps, curl, Render
// health-checks) tillades altid — CORS er kun en browser-protection-mekanisme.
const allowedOrigins = new Set([
  'https://aidkick.app',
  'https://www.aidkick.app',
  'https://echolima-769c7.web.app',
  'https://echolima-769c7.firebaseapp.com'
])
const localhostRegex = /^http:\/\/localhost(:\d+)?$/

app.use(cors({
  origin: (origin, callback) => {
    // Ingen Origin = ikke browser-request (mobile/server/curl) → tillad
    if (!origin) return callback(null, true)
    // Allowlist match → tillad
    if (allowedOrigins.has(origin)) return callback(null, true)
    // Localhost (alle porte) → tillad (lokal dev)
    if (localhostRegex.test(origin)) return callback(null, true)
    // Alt andet → afvis + log så vi fanger ukendte origins der prøver
    console.warn(`CORS: blokeret origin: ${origin}`)
    callback(new Error(`Origin not allowed by CORS: ${origin}`))
  },
  credentials: true  // tillader auth-headers + cookies fra approved origins
}))

// Health check — placeret FØR rate-limiter (generalLimiter) så Render's
// health-pings ikke regnes med i rate-budget'et. Et simpelt GET behøver hverken
// body-parsing eller rate-limiting og bør have lavest mulig latency så
// health-checks aldrig timer ud.
app.get('/health', (_, res) => {
  res.json({ status: 'ok', service: 'echolima-api', timestamp: Date.now() })
})

// Stripe webhook kræver raw body — registreres FØR express.json()
app.use('/stripe/webhook', express.raw({ type: 'application/json' }))

app.use(express.json({ limit: '10mb' }))
app.use(generalLimiter)

// Stripe redirect sider
app.get('/payment/success', (_, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Betaling gennemført</title>
  <style>body{font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0a0a0a;color:#fff;}
  h1{font-size:2rem;margin-bottom:8px;}p{color:#aaa;text-align:center;}</style></head>
  <body><div style="font-size:3rem">✅</div><h1>Betaling gennemført</h1>
  <p>Dit abonnement er aktiveret.<br>Du kan nu lukke denne fane og vende tilbage til AidKick.</p></body></html>`)
})

app.get('/payment/cancel', (_, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Betaling annulleret</title>
  <style>body{font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0a0a0a;color:#fff;}
  h1{font-size:2rem;margin-bottom:8px;}p{color:#aaa;text-align:center;}</style></head>
  <body><div style="font-size:3rem">❌</div><h1>Betaling annulleret</h1>
  <p>Betalingen blev ikke gennemført.<br>Du kan lukke denne fane og prøve igen fra AidKick.</p></body></html>`)
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
app.use('/niches', nichesRoutes)
app.use('/telemetry', telemetryRoutes)

// 404 — opdateret til struktureret error-format for konsistens med øvrige endpoints
app.use((_, res) => {
  res.status(404).json({ error: 'endpoint_not_found', message: 'Endpoint ikke fundet' })
})

app.listen(PORT, () => {
  console.log(`EchoLima API kører på port ${PORT}`)
})

export default app