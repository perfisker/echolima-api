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

    const payload: Parameters<Resend['emails']['send']>[0] = {
      from: 'EchoLima <noreply@echolima.app>',
      to: Array.isArray(to) ? to : [to],
      subject,
      ...(html ? { html } : {}),
      ...(text ? { text } : {})
    }

    // Vedhæftninger: base64-strenge sendes direkte videre til Resend
    if (attachments && Array.isArray(attachments) && attachments.length > 0) {
      payload.attachments = attachments.map((a: { filename: string; content: string }) => ({
        filename: a.filename,
        content: Buffer.from(a.content, 'base64')
      }))
    }

    const result = await resend.emails.send(payload)

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
