import { initializeApp, cert } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'
import * as fs from 'fs'
import * as path from 'path'

const serviceAccountPath = path.resolve(__dirname, '../service-account.json')
const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'))

initializeApp({ credential: cert(serviceAccount) })

// ─────────────────────────────────────────────────────────────────────────────
// Test-script: verificér V1.4 PiiShield-attachment på /email/send
//
// Sender to test-emails:
//   1. Uden PiiShield → forventet: ingen attachment (backward-compat)
//   2. Med PiiShield → forventet: PDF "PiiShield_mode_med_anders_YYYY-MM-DD.pdf"
//
// Resultater skrives til Firestore tests/{auto-id} for audit.
//
// Kør:
//   $env:FIREBASE_API_KEY = "<din-web-api-key>"
//   $env:TEST_UID = "<din-Firebase-Auth-UID>"
//   $env:TEST_RECIPIENT = "per.fisker@gmail.com"  # email du har adgang til
//   npx ts-node scripts/testPiiShieldEmail.ts
// ─────────────────────────────────────────────────────────────────────────────

const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY ?? ''
const TEST_UID = process.env.TEST_UID ?? ''
const TEST_RECIPIENT = process.env.TEST_RECIPIENT ?? ''
const BACKEND_URL = process.env.BACKEND_URL ?? 'https://api.echolima.app'

if (!FIREBASE_API_KEY || !TEST_UID || !TEST_RECIPIENT) {
  console.error('FEJL: Sæt FIREBASE_API_KEY, TEST_UID og TEST_RECIPIENT som env vars.')
  process.exit(1)
}

async function getIdToken(): Promise<string> {
  const customToken = await getAuth().createCustomToken(TEST_UID)
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: customToken, returnSecureToken: true })
    }
  )
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`)
  const data = await res.json() as { idToken: string }
  return data.idToken
}

async function postSend(idToken: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BACKEND_URL}/email/send`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${idToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

async function main() {
  console.log('═'.repeat(70))
  console.log('V1.4 PiiShield-attachment verifikations-test')
  console.log('═'.repeat(70))
  console.log(`Backend:   ${BACKEND_URL}`)
  console.log(`Recipient: ${TEST_RECIPIENT}`)
  console.log()

  console.log('Henter ID token...')
  const idToken = await getIdToken()
  console.log('✓ Token modtaget')
  console.log()

  // ── Test 1: backward-compat (ingen PiiShield-felter) ──
  console.log('Test 1: /email/send UDEN PiiShield (backward-compat)...')
  const test1Start = Date.now()
  const test1 = await postSend(idToken, {
    to: [TEST_RECIPIENT],
    subject: '[Test 1] V1.4 backward-compat',
    html: '<p>Dette er en test af /email/send <strong>uden</strong> PiiShield-felter. Forventet: ingen attachment.</p>'
  })
  const test1Duration = Date.now() - test1Start
  const test1Pass = test1.status === 200 && test1.body?.success === true
  console.log(`  Status: ${test1.status} (${test1Duration}ms)`)
  console.log(`  Body:   ${JSON.stringify(test1.body)}`)
  console.log(`  Pass:   ${test1Pass ? '✅' : '❌'}`)
  console.log()

  // ── Test 2: med PiiShield-attachment ──
  console.log('Test 2: /email/send MED PiiShield (attachment forventes)...')
  const test2Start = Date.now()
  const test2 = await postSend(idToken, {
    to: [TEST_RECIPIENT],
    subject: '[Test 2] V1.4 PiiShield-attachment',
    html: '<p>Test af PiiShield-PDF. Indeholder anders@firma.dk + telefon 12345678.</p>',
    attach_pii_shield: true,
    pii_types: ['email', 'phone'],
    noteTitle: 'Møde med Anders',
    pii_instance_counts: { email: 1, phone: 1 },
    pii_detection_method: 'regex+nlu',
    pii_detection_confidence: 'high'
  })
  const test2Duration = Date.now() - test2Start
  const test2Pass = test2.status === 200 && test2.body?.success === true
  console.log(`  Status: ${test2.status} (${test2Duration}ms)`)
  console.log(`  Body:   ${JSON.stringify(test2.body)}`)
  console.log(`  Pass:   ${test2Pass ? '✅' : '❌'}`)
  console.log()

  // ── Skriv samlet resultat til Firestore ──
  console.log('Skriver resultater til Firestore tests/{auto-id}...')
  const db = getFirestore()
  const ref = db.collection('tests').doc()
  await ref.set({
    testName: 'v1.4_pii_shield_email',
    runAt: Date.now(),
    backend: BACKEND_URL,
    testUid: TEST_UID,
    testRecipient: TEST_RECIPIENT,
    test1: {
      description: 'backward-compat (no PiiShield fields)',
      status: test1.status,
      durationMs: test1Duration,
      body: test1.body,
      passed: test1Pass
    },
    test2: {
      description: 'with PiiShield attachment',
      status: test2.status,
      durationMs: test2Duration,
      body: test2.body,
      passed: test2Pass
    }
  })
  console.log(`  ✓ Skrevet til tests/${ref.id}`)
  console.log()

  console.log('═'.repeat(70))
  console.log('SAMLET RESULTAT')
  console.log('═'.repeat(70))
  console.log(`Test 1 (backward-compat):   ${test1Pass ? '✅ PASS' : '❌ FAIL'}`)
  console.log(`Test 2 (PiiShield-attach):  ${test2Pass ? '✅ PASS' : '❌ FAIL'}`)
  console.log()
  console.log(`MANUEL BEKRÆFTELSE NØDVENDIG:`)
  console.log(`  → Åbn ${TEST_RECIPIENT} indbakke`)
  console.log(`  → Test 1-email: INGEN attachment forventet`)
  console.log(`  → Test 2-email: PDF "PiiShield_mode_med_anders_YYYY-MM-DD.pdf" forventet`)
  console.log(`  → Inspect PDF: header med AidKick + metadata + PII-typer + GDPR-info`)
  console.log()
  console.log(`Firebase Console: tests/${ref.id}`)
  console.log('═'.repeat(70))

  process.exit((test1Pass && test2Pass) ? 0 : 1)
}

main().catch((err) => {
  console.error('Test fejlede med exception:', err)
  process.exit(1)
})
