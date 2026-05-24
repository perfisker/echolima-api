import { Router, Response } from 'express'
import { Resend } from 'resend'
import { AuthRequest } from '../types'
import { verifyToken } from '../middleware/auth'

const router = Router()

function getResend(): Resend {
  const key = process.env.RESEND_API_KEY
  if (!key) throw new Error('RESEND_API_KEY er ikke sat')
  return new Resend(key)
}

/**
 * Læs from-adresse fra env-var EMAIL_FROM. Formatet skal være Resend-kompatibelt:
 *   - "AidKick <noreply@aidkick.app>"   (display name + email)
 *   - "noreply@aidkick.app"             (kun email)
 *
 * Husk at det DOMÆNE der bruges i from-adressen SKAL være DKIM-verificeret i
 * Resend Dashboard. Ellers afvises mails af modtagerens SPF/DKIM-check.
 *
 * Fallback: 'AidKick <noreply@aidkick.app>' (rebrandet fra EchoLima 23. maj 2026).
 * Hvis Render env-var ikke er sat, bruges fallback'en — log advarsel så vi
 * fanger det i Render-logs hvis nogen senere glemmer at sætte env-var'en.
 */
function getFromAddress(): string {
  const fromEnv = process.env.EMAIL_FROM
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim()
  const fallback = 'AidKick <noreply@aidkick.app>'
  console.warn(`email.ts: EMAIL_FROM env-var ikke sat — bruger fallback '${fallback}'. Sæt EMAIL_FROM i Render Environment.`)
  return fallback
}

// POST /email/send
// Body: {
//   to: string | string[],
//   subject: string,
//   html?: string,
//   text?: string,
//   attachments?: Array<{ filename: string, content: string /* base64 */ }>
// }
router.post('/send', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const { to, subject, html, text, attachments } = req.body

    if (!to || !subject) {
      res.status(400).json({ error: 'Mangler "to" eller "subject"' })
      return
    }

    const resend = getResend()

    // Resend kræver at html eller text altid er til stede (ikke bare optionelt)
    const resolvedHtml: string = html ?? (text ? `<pre style="font-family:sans-serif">${text}</pre>` : '<p></p>')

    const resolvedAttachments = (attachments && Array.isArray(attachments) && attachments.length > 0)
      ? attachments.map((a: { filename: string; content: string }) => ({
          filename: a.filename,
          content: Buffer.from(a.content, 'base64')
        }))
      : undefined

    const result = await resend.emails.send({
      from: getFromAddress(),
      to: Array.isArray(to) ? to : [to],
      subject,
      html: resolvedHtml,
      ...(text ? { text } : {}),
      ...(resolvedAttachments ? { attachments: resolvedAttachments } : {})
    })

    if (result.error) {
      console.error('Resend fejl:', result.error)
      res.status(502).json({ error: result.error.message })
      return
    }

    res.json({ success: true, id: result.data?.id })
  } catch (err) {
    console.error('email/send fejl:', err)
    res.status(500).json({ error: 'Email-afsendelse fejlede' })
  }
})

export default router
