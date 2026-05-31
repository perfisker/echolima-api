import { initializeApp, cert } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'
import * as fs from 'fs'
import * as path from 'path'

const serviceAccountPath = path.resolve(__dirname, '../service-account.json')
const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'))

initializeApp({ credential: cert(serviceAccount) })

// ─────────────────────────────────────────────────────────────────────────────
// Test-script: verificér V1.3 send_email content_ref quickfix
//
// Formål:
//   Verificere at /intents/parse returnerer content_ref="deltagere" (ikke "all")
//   når klienten sender extraFields-OBJECT i stedet for extraFieldNames-ARRAY.
//
// Flow:
//   1. Mint custom token via Firebase Admin SDK
//   2. Exchange til ID token via Firebase Auth REST API
//   3. POST /intents/parse med test-payload
//   4. Skriv resultat til Firestore tests/{auto-id} så bruger kan inspicere
//      i Firebase Console uden at læse PowerShell-output
//   5. Log også til console
//
// Kør:
//   $env:FIREBASE_API_KEY = "<din-web-api-key-fra-Firebase-Console>"
//   $env:TEST_UID = "<din-egen-Firebase-Auth-UID>"
//   npx ts-node scripts/testSendEmailIntent.ts
//
// Hent FIREBASE_API_KEY: Firebase Console → Project Settings → General →
//   "Web API Key" (ikke server-key — det er Web API Key)
// Hent TEST_UID: Firebase Console → Authentication → Users → kopier din egen uid
// ─────────────────────────────────────────────────────────────────────────────

const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY ?? ''
const TEST_UID = process.env.TEST_UID ?? ''
const BACKEND_URL = process.env.BACKEND_URL ?? 'https://api.echolima.app'

if (!FIREBASE_API_KEY || !TEST_UID) {
  console.error('FEJL: Sæt FIREBASE_API_KEY og TEST_UID som environment variables.')
  console.error('  PowerShell: $env:FIREBASE_API_KEY = "..."; $env:TEST_UID = "..."')
  process.exit(1)
}

// Test-payload — præcis den case fra Architecture-WS quickfix-prompt
const TEST_PAYLOAD = {
  intentId: 'send_email',
  transcript: 'send deltagerlisten til Søren',
  noteContext: {
    summary: 'Møde om Q3',
    extraFields: {
      deltagere: ['Anders', 'Bo', 'Carlos'],
      beslutninger: ['Beslutning 1']
    }
  }
}

async function main() {
  console.log('═'.repeat(70))
  console.log('V1.3 send_email content_ref quickfix — verifikations-test')
  console.log('═'.repeat(70))
  console.log(`Backend:  ${BACKEND_URL}`)
  console.log(`Test UID: ${TEST_UID}`)
  console.log(`Payload:  ${JSON.stringify(TEST_PAYLOAD, null, 2)}`)
  console.log()

  // ── 1. Mint custom token ──
  console.log('Step 1: Minter custom token via Admin SDK...')
  const customToken = await getAuth().createCustomToken(TEST_UID)
  console.log('  ✓ custom token mintet')

  // ── 2. Exchange til ID token ──
  console.log('Step 2: Exchanger til ID token via Firebase REST API...')
  const exchangeRes = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: customToken, returnSecureToken: true })
    }
  )

  if (!exchangeRes.ok) {
    const errText = await exchangeRes.text()
    console.error('  ✗ Token-exchange fejlede:', exchangeRes.status, errText)
    process.exit(1)
  }

  const exchangeData = await exchangeRes.json() as { idToken: string }
  const idToken = exchangeData.idToken
  console.log(`  ✓ ID token modtaget (første 40 tegn: ${idToken.substring(0, 40)}...)`)

  // ── 3. POST /intents/parse ──
  console.log('Step 3: POST /intents/parse...')
  const parseStart = Date.now()
  const parseRes = await fetch(`${BACKEND_URL}/intents/parse`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${idToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(TEST_PAYLOAD)
  })
  const parseDurationMs = Date.now() - parseStart

  const parseStatus = parseRes.status
  const parseBody = await parseRes.json() as Record<string, unknown>
  console.log(`  ✓ Response: HTTP ${parseStatus} (${parseDurationMs}ms)`)
  console.log(`  Body: ${JSON.stringify(parseBody, null, 2)}`)

  // ── 4. Skriv til Firestore tests/{auto-id} ──
  console.log('Step 4: Skriver resultat til Firestore tests/{auto-id}...')
  const db = getFirestore()
  const testDocRef = db.collection('tests').doc()
  const slots = (parseBody.slots ?? {}) as Record<string, unknown>
  const contentRef = slots.content_ref
  const recipientRef = slots.recipient_ref

  // Quickfix-verifikation: content_ref skal være "deltagere", ikke "all"
  const passed = contentRef === 'deltagere'

  await testDocRef.set({
    testName: 'v1.3_send_email_content_ref_quickfix',
    runAt: Date.now(),
    backend: BACKEND_URL,
    testUid: TEST_UID,
    payload: TEST_PAYLOAD,
    response: {
      httpStatus: parseStatus,
      body: parseBody,
      durationMs: parseDurationMs
    },
    verification: {
      expectedContentRef: 'deltagere',
      actualContentRef: contentRef,
      recipientRef,
      passed
    }
  })
  console.log(`  ✓ Skrevet til tests/${testDocRef.id}`)

  // ── 5. Sammenfatning ──
  console.log()
  console.log('═'.repeat(70))
  console.log('RESULTAT')
  console.log('═'.repeat(70))
  console.log(`HTTP status:        ${parseStatus}`)
  console.log(`recipient_ref:      ${JSON.stringify(recipientRef)}`)
  console.log(`content_ref:        ${JSON.stringify(contentRef)}`)
  console.log(`Forventet:          "deltagere"`)
  console.log(`Quickfix virker:    ${passed ? '✅ JA' : '❌ NEJ (stadig "' + contentRef + '")'}`)
  console.log()
  console.log(`Inspect i Firebase Console: tests/${testDocRef.id}`)
  console.log('═'.repeat(70))

  process.exit(passed ? 0 : 1)
}

main().catch((err) => {
  console.error('Test fejlede med exception:', err)
  process.exit(1)
})
