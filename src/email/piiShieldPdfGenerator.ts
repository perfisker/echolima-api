import PDFDocument from 'pdfkit'

// ─────────────────────────────────────────────────────────────────────────────
// PiiShield PDF Generator (V1.4, 1. juni 2026)
//
// Genererer en GDPR-audit-PDF der vedhæftes emails der indeholder personoplysninger.
// PDF'en dokumenterer hvilke typer PII der blev fundet i noten (uden at gengive
// faktiske værdier — ingen excerpts), så afsenderen har et bilag der viser
// at GDPR-bevidst håndtering blev praktiseret.
//
// Designprincip: PDF'en er BILAGET, ikke maskeringen. Det er afsenderens
// dokumentation, ikke modtagerens beskyttelse. Faktisk PII-redaction sker
// (eller sker ikke) på Android-klientens side INDEN det sendes til /email/send.
//
// Layout: A4, margin 50pt. Header med AidKick-wordmark + GDPR-audit-titel.
// Metadata-blok. PII-typer med forekomst-counts. GDPR-info. Footer.
//
// Performance: ~50-150ms per PDF afhængigt af PII-types-count. Buffer ~30-50KB.
// Cold start kan tage længere første kald efter Render-restart.
// ─────────────────────────────────────────────────────────────────────────────

export interface PiiShieldData {
  noteTitle: string
  senderEmail: string
  recipientEmail: string
  sentAt: number
  piiTypes: string[]
  instanceCounts?: Record<string, number>  // valgfri pr. type-count fra klient
  detectionMethod?: string                  // valgfri, fx "regex+nlu"
  detectionConfidence?: string              // valgfri, fx "high" / "medium"
}

const TYPE_LABELS: Record<string, string> = {
  email: 'Email-adresser',
  phone: 'Telefonnumre',
  cpr: 'CPR-numre',
  name: 'Personnavne',
  address: 'Adresser',
  creditcard: 'Kreditkortnumre',
  iban: 'IBAN/Kontonumre'
}

export async function generatePiiShieldPdf(data: PiiShieldData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const doc = new PDFDocument({ size: 'A4', margin: 50 })

    doc.on('data', (chunk: Buffer) => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    // ─── Header: AidKick wordmark + rapport-titel ───
    doc.fontSize(24).fillColor('#FC6404').text('AidKick', { align: 'left' })
    doc.moveDown(0.5)
    doc.fontSize(18).fillColor('#000000').text('PiiShield-rapport')
    doc.fontSize(12).fillColor('#666666').text('GDPR-audit')
    doc.moveDown()

    // Horizontal rule
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#cccccc').stroke()
    doc.moveDown()

    // ─── Metadata-blok ───
    doc.fontSize(11).fillColor('#000000')
    doc.text(`Note:        ${data.noteTitle}`)
    doc.text(`Afsender:    ${data.senderEmail}`)
    doc.text(`Modtager:    ${data.recipientEmail}`)
    doc.text(
      `Sendt:       ${new Date(data.sentAt).toLocaleString('da-DK', { timeZone: 'Europe/Copenhagen' })}`
    )
    doc.moveDown()

    // ─── PII-sektion header ───
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#cccccc').stroke()
    doc.moveDown(0.5)
    doc.fontSize(14).text('Persondata fundet i denne note')
    doc.moveDown(0.5)
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#cccccc').stroke()
    doc.moveDown()

    // ─── PII-typer liste (ingen excerpts — kun typer + counts) ───
    doc.fontSize(11)
    if (data.piiTypes.length === 0) {
      doc.fillColor('#666666').text('  (ingen specifikke PII-typer markeret)')
      doc.fillColor('#000000')
    } else {
      for (const piiType of data.piiTypes) {
        const label = TYPE_LABELS[piiType] ?? piiType
        const count = data.instanceCounts?.[piiType]
        const countStr = count !== undefined
          ? ` (${count} ${count === 1 ? 'forekomst' : 'forekomster'})`
          : ''
        doc.text(`  ✓  ${label}${countStr}`)
      }
    }
    doc.moveDown()

    // ─── Detektions-metadata (kun hvis sendt) ───
    if (data.detectionMethod || data.detectionConfidence) {
      doc.fontSize(10).fillColor('#666666')
      if (data.detectionMethod) doc.text(`Detektion: ${data.detectionMethod}`)
      if (data.detectionConfidence) doc.text(`Konfidens: ${data.detectionConfidence}`)
      doc.fillColor('#000000')
      doc.moveDown()
    }

    // ─── GDPR-info-sektion ───
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#cccccc').stroke()
    doc.moveDown(0.5)
    doc.fontSize(14).text('GDPR-information')
    doc.moveDown(0.5)
    doc.fontSize(11).fillColor('#000000').text(
      'Denne email indeholder personoplysninger. Håndtér i ' +
      'overensstemmelse med din organisations databehandlings-' +
      'politikker. Afsenderen blev gjort opmærksom på PII-' +
      'indholdet inden forsendelse.',
      { align: 'left' }
    )
    doc.moveDown()

    // ─── Footer ───
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#cccccc').stroke()
    doc.moveDown(0.5)
    doc.fontSize(9).fillColor('#999999').text(
      'AidKick — automatisk audit-trail',
      { align: 'center' }
    )

    doc.end()
  })
}

/**
 * Slug-helper til filnavne. Erstatter danske tegn + ikke-alfanumeriske
 * med underscores. Max 40 tegn for at undgå for lange filnavne.
 *
 * "Møde med Anders" → "mode_med_anders"
 * "Mødereferat: Q3 strategi" → "modereferat_q3_strategi"
 * Tom string eller kun symboler → "rapport"
 */
export function slugifyForFilename(s: string): string {
  const slug = s.toLowerCase()
    .replace(/[æ]/g, 'ae')
    .replace(/[ø]/g, 'o')
    .replace(/[å]/g, 'a')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .substring(0, 40)
  return slug.length > 0 ? slug : 'rapport'
}
