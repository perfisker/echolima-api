import { Router, Request, Response } from 'express'
import rateLimit from 'express-rate-limit'
import { getFirestore } from 'firebase-admin/firestore'
import { Resend } from 'resend'
import * as crypto from 'crypto'
import { ContactRequestDoc, ContactRequestSource } from '../types'

const router = Router()

// ─────────────────────────────────────────────────────────────────────────────
// POST /contact_requests — public kontakt-formular-endpoint
//
// Designet til Web-WS' kontakt-modal (echo_tier_inquiry) + fremtidig in-app
// kontakt-flow. Founder-godkendte specs 25. maj 2026:
//   - Public auth (ingen Firebase token)
//   - To-lags rate-limit: 5/IP/time + 20/IP/dag
//   - Firestore /contact_requests/{auto-id} + Resend notification
//   - Notifications-receiver: ADMIN_EMAIL env-var (default per.fisker@gmail.com)
//   - Honeypot 'website'-felt: bots udfylder typisk alt → vi fanger dem stille
//   - SHA256(ip) gemmes til anti-spam tracking uden at gemme PII
//
// GDPR:
//   - name/email/message anonymiseres via onUserDelete Cloud Function når
//     bruger sletter konto (matchet på email-felt)
//   - Resolved requests > 12 mdr slettes via cleanupOldContactRequests
//     scheduled function
// ─────────────────────────────────────────────────────────────────────────────

// ─── Lazy Resend client (matcher pattern fra email.ts) ───
function getResend(): Resend {
  const key = process.env.RESEND_API_KEY
  if (!key) throw new Error('RESEND_API_KEY er ikke sat')
  return new Resend(key)
}

// ─── Rate-limit (to lag — stacked som middleware på route) ───
// Hourly = beskytter mod burst-spam. Daily = beskytter mod langsom drypvis-spam.
// Begge skal passere før request når validate-laget.
const hourlyLimit = rateLimit({
  windowMs: 60 * 60 * 1000,    // 1 time
  max: 5,
  message: { error: 'rate_limited', message: 'For mange forespørgsler. Prøv igen om en time.' },
  standardHeaders: true,
  legacyHeaders: false
})

const dailyLimit = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 timer
  max: 20,
  message: { error: 'rate_limited', message: 'For mange forespørgsler. Prøv igen i morgen.' },
  standardHeaders: true,
  legacyHeaders: false
})

// ─── Validation ───
const EMAIL_REGEX = /^[\w._%+-]+@[\w.-]+\.[A-Za-z]{2,}$/
const VALID_SOURCES: ContactRequestSource[] = ['aidkick_web', 'aidkick_app', 'echo_tier_inquiry']

interface ValidationResult {
  valid: boolean
  error?: string
  message?: string
}

function validateBody(body: any): ValidationResult {
  if (!body || typeof body !== 'object') {
    return { valid: false, error: 'invalid_body', message: 'Body skal være JSON.' }
  }

  // HONEYPOT: hvis 'website'-felt er udfyldt → bot → silent drop.
  // Returnerer 200 success til botten så den ikke prøver igen, men gemmer intet.
  if (body.website && typeof body.website === 'string' && body.website.trim().length > 0) {
    return { valid: false, error: 'honeypot_triggered', message: 'OK' }
  }

  if (!body.name || typeof body.name !== 'string' || body.name.trim().length < 1 || body.name.length > 100) {
    return { valid: false, error: 'invalid_name', message: 'Navn skal være mellem 1 og 100 tegn.' }
  }

  if (!body.email || typeof body.email !== 'string' || !EMAIL_REGEX.test(body.email)) {
    return { valid: false, error: 'invalid_email', message: 'Ugyldig email-adresse.' }
  }

  if (!body.message || typeof body.message !== 'string' || body.message.trim().length < 5 || body.message.length > 5000) {
    return { valid: false, error: 'invalid_message', message: 'Besked skal være mellem 5 og 5000 tegn.' }
  }

  if (!body.source || !VALID_SOURCES.includes(body.source)) {
    return { valid: false, error: 'invalid_source', message: 'Ugyldig source.' }
  }

  return { valid: true }
}

// ─── POST /contact_requests ───
router.post('/', hourlyLimit, dailyLimit, async (req: Request, res: Response) => {
  try {
    const validation = validateBody(req.body)

    // Honeypot triggered → silent succes (bot må ikke vide den blev fanget)
    if (validation.error === 'honeypot_triggered') {
      res.status(200).json({ success: true })
      return
    }

    if (!validation.valid) {
      res.status(400).json({ error: validation.error, message: validation.message })
      return
    }

    const { name, email, message, source } = req.body
    const userAgent = req.get('user-agent')?.substring(0, 500)

    // Hash IP for anti-spam tracking uden at gemme PII. Bruger Render's
    // forwarded IP via app.set('trust proxy', 1) i index.ts. Falder tilbage
    // til socket-IP hvis header-IP mangler.
    const clientIp = (req.ip ?? req.socket.remoteAddress ?? 'unknown').toString()
    const ipHash = crypto.createHash('sha256').update(clientIp).digest('hex')

    // Skriv til Firestore
    const db = getFirestore()
    const docRef = db.collection('contact_requests').doc()
    const doc: ContactRequestDoc = {
      id: docRef.id,
      name: name.trim(),
      email: email.trim().toLowerCase(),
      message: message.trim(),
      source,
      status: 'new',
      ts: Date.now(),
      ipHash
    }
    if (userAgent) doc.userAgent = userAgent
    await docRef.set(doc)

    // Send notification email via Resend (fire-and-forget — ikke blokerende
    // for response, så hvis Resend er nede svigter API ikke for bruger).
    sendNotificationEmail(doc).catch(err => {
      console.error('contact_requests: Resend notification failed', err)
    })

    res.status(201).json({ success: true, id: doc.id })
  } catch (err) {
    console.error('contact_requests fejl:', err)
    res.status(500).json({ error: 'server_error', message: 'Serverfejl. Prøv igen senere.' })
  }
})

// ─── Notification email ───
// From-adressen bruger aidkick.app (DKIM-verified i Resend Dashboard 23. maj
// 2026). Display name "AidKick Support" differentierer fra transactional
// emails der bruger getFromAddress() i email.ts. Hvis du senere får dedikeret
// support@aidkick.app forwarder, kan ADMIN_EMAIL pege på den.
//
// replyTo: doc.email → klik "Reply" i Gmail går direkte til kontaktpersonen
// uden manual copy-paste af email-adressen.
async function sendNotificationEmail(doc: ContactRequestDoc): Promise<void> {
  const adminEmail = process.env.ADMIN_EMAIL ?? 'per.fisker@gmail.com'
  const fromAddress = process.env.CONTACT_NOTIFICATION_FROM ?? 'AidKick Support <noreply@aidkick.app>'

  await getResend().emails.send({
    from: fromAddress,
    to: [adminEmail],
    reply_to: doc.email,  // Resend SDK bruger snake_case
    subject: `[AidKick] Ny kontakt-request fra ${doc.name}`,
    text: `Fra: ${doc.name} <${doc.email}>
Source: ${doc.source}
Time: ${new Date(doc.ts).toISOString()}

Besked:
${doc.message}

---
Se i Firestore: contact_requests/${doc.id}
Marker som "in_progress" eller "resolved" når du har svaret.`
  })
}

export default router
