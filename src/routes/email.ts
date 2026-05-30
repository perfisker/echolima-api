import { Router, Response } from 'express'
import { Resend } from 'resend'
import { getFirestore } from 'firebase-admin/firestore'
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

// ─────────────────────────────────────────────────────────────────────────────
// POST /email/compose-send — V1.3 Voice Intent send_email-action
//
// Body:
//   recipient_ref: string                              — kontaktens navn (resolves til email)
//   content_ref:   "all" | "summary" | number[] | string — hvilken del af noten
//   noteContent:   { summary?, tasks?, transcription?, extraFields? }
//
// Kaldt af Android EFTER Voice Intent send_email preview_dialog-bekræftelse.
// Backend resolver modtager-email og bygger email-body — klienten sender aldrig
// råt til /email/send (sikkerheds-pattern: ingen klient-styrede modtager-emails
// for at undgå at gøre echolima-api til en åben SMTP-relay).
//
// recipient_ref resolution:
//   1. users/{uid}/contacts subcollection, case-insensitive name-match
//   2. Defensiv fallback: hvis recipient_ref ER en gyldig email, accepter direkte
//   3. Ellers: 404 recipient_not_found
//
// content_ref → email-body mapping:
//   "all"     → summary + tasks + alle extraFields (formateret som markdown-light)
//   "summary" → kun summary
//   number[]  → kun de nævnte tasks (1-baseret, fx [1,3] → tasks[0] + tasks[2])
//   string    → extraFields[string] (fx "deltagere" → extraFields.deltagere)
//   ukendt    → fallback til "all"
// ─────────────────────────────────────────────────────────────────────────────
router.post('/compose-send', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const uid = req.user!.uid
    const { recipient_ref, content_ref, noteContent } = req.body

    if (!recipient_ref || typeof recipient_ref !== 'string') {
      res.status(400).json({ error: 'missing_params', message: 'recipient_ref er påkrævet' })
      return
    }
    if (!noteContent || typeof noteContent !== 'object') {
      res.status(400).json({ error: 'missing_params', message: 'noteContent er påkrævet' })
      return
    }

    // ── Resolver recipient_ref → email ──
    // Case-insensitive name-match mod brugerens kontaktbog. Hvis bruger har
    // 2+ kontakter med samme navn (sjældent), tager vi den første. Edge case
    // som Voice Engine kunne disambiguere i fremtidige iterationer.
    const contactsSnap = await getFirestore()
      .collection('users').doc(uid).collection('contacts').get()
    const contact = contactsSnap.docs
      .map(d => d.data())
      .find(c => typeof c.name === 'string' &&
        c.name.toLowerCase() === recipient_ref.toLowerCase())

    // Defensiv fallback: hvis recipient_ref tilfældigvis ER en gyldig email,
    // accepter den direkte. Sker hvis Android-klienten ikke disambiguerer
    // mellem navn og email på voice-input-niveau.
    const looksLikeEmail = /^[\w._%+-]+@[\w.-]+\.[A-Za-z]{2,}$/.test(recipient_ref)
    const toEmail: string | undefined = (typeof contact?.email === 'string' ? contact.email : undefined)
      ?? (looksLikeEmail ? recipient_ref : undefined)

    if (!toEmail) {
      res.status(404).json({
        error: 'recipient_not_found',
        message: `Kontakt '${recipient_ref}' ikke fundet eller mangler email`
      })
      return
    }

    // ── Byg email-body ud fra content_ref ──
    const { summary, tasks, extraFields } = noteContent as {
      summary?: string
      tasks?: string[]
      transcription?: string
      extraFields?: Record<string, unknown>
    }
    const safeTasks: string[] = Array.isArray(tasks)
      ? tasks.filter((t): t is string => typeof t === 'string')
      : []
    const resolvedRef = content_ref ?? 'all'

    const bodyParts: string[] = []

    if (resolvedRef === 'all') {
      if (typeof summary === 'string' && summary.length > 0) {
        bodyParts.push(`**Resumé:**\n${summary}`)
      }
      if (safeTasks.length > 0) {
        bodyParts.push(`**Opgaver:**\n${safeTasks.map((t, i) => `${i + 1}. ${t}`).join('\n')}`)
      }
      if (extraFields && typeof extraFields === 'object') {
        Object.entries(extraFields).forEach(([key, val]) => {
          const display = Array.isArray(val) ? val.join(', ') : String(val ?? '')
          if (display) bodyParts.push(`**${key}:** ${display}`)
        })
      }
    } else if (resolvedRef === 'summary') {
      bodyParts.push(typeof summary === 'string' && summary ? summary : '(intet resumé)')
    } else if (Array.isArray(resolvedRef)) {
      // number[] — 1-baserede indekser
      const selected = (resolvedRef as unknown[])
        .filter((n): n is number => typeof n === 'number' && n >= 1 && n <= safeTasks.length)
        .map(n => `${n}. ${safeTasks[n - 1]}`)
      bodyParts.push(selected.length > 0 ? selected.join('\n') : '(ingen matchende opgaver)')
    } else if (typeof resolvedRef === 'string' && extraFields && extraFields[resolvedRef] !== undefined) {
      // ExtraField ID — niche-felt
      const val = extraFields[resolvedRef]
      bodyParts.push(Array.isArray(val) ? val.join('\n') : String(val ?? ''))
    } else {
      // Ukendt content_ref — defensiv fallback til "all"
      console.warn(`email/compose-send: ukendt content_ref '${JSON.stringify(resolvedRef)}', falder tilbage til "all"`)
      if (typeof summary === 'string' && summary.length > 0) {
        bodyParts.push(`**Resumé:**\n${summary}`)
      }
      if (safeTasks.length > 0) {
        bodyParts.push(safeTasks.map((t, i) => `${i + 1}. ${t}`).join('\n'))
      }
    }

    const emailBody = bodyParts.join('\n\n') || '(ingen indhold)'
    const emailHtml = emailBody
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>')

    // ── Send via Resend ──
    const resend = getResend()
    const result = await resend.emails.send({
      from: getFromAddress(),
      to: [toEmail],
      subject: 'Dine noter fra AidKick',
      html: `<div style="font-family:sans-serif;max-width:600px">${emailHtml}</div>`,
      text: emailBody
    })

    if (result.error) {
      console.error('email/compose-send Resend-fejl:', result.error)
      res.status(502).json({ error: 'email_send_failed', message: result.error.message })
      return
    }

    // ── Log telemetri (best-effort) ──
    try {
      await getFirestore().collection('events').add({
        uid,
        appId: 'echolima',
        type: 'email_compose_sent',
        intentId: 'send_email',
        recipientRef: recipient_ref,
        contentRef: resolvedRef,
        timestamp: Date.now()
      })
    } catch (logErr) {
      console.error('email/compose-send event-log fejl (response sendes alligevel):', logErr)
    }

    res.json({ sent: true, emailId: result.data?.id, to: toEmail })
  } catch (err) {
    console.error('email/compose-send fejl:', err)
    res.status(500).json({ error: 'server_error', message: 'Serverfejl' })
  }
})

export default router
