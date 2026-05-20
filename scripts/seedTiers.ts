import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import * as fs from 'fs'
import * as path from 'path'

const serviceAccountPath = path.resolve(__dirname, '../service-account.json')
const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'))

initializeApp({ credential: cert(serviceAccount) })

const db = getFirestore()

// Tier-IDs er opaque (Arch #2 migration). Visning af navne/beskrivelser sker
// via displayName + description på dette doc — ikke længere via strings.xml.
//
// Counter-model (refactored 20. maj 2026):
//   voiceNotesPerMonth  = quota for noter UDEN billeder (voice-only)
//   cameraNotesPerMonth = quota for noter MED billeder (camera+voice)
//   storageMB           = grænse for samlet fil-storage i Firebase Storage
//
// Bagved kulisserne tæller hver voice-only note ét /ai/transcribe + ét
// /ai/analyze, hver kamera-note tæller transcribe + describe-images + analyze.
// Brugeren ser kun de to aggregerede counters. -1 betyder ubegrænset.
const tiers = [
  {
    id: 'tier_free',
    displayName: { da: 'Foxtrot', en: 'Foxtrot' },
    description: { da: 'For dig der vil prøve AidKick', en: 'For trying out AidKick' },
    price: 0,
    currency: 'DKK',
    voiceNotesPerMonth: 5,
    cameraNotesPerMonth: 3,
    storageMB: 100,
    active: true,
    order: 1,
  },
  {
    id: 'tier_basic',
    displayName: { da: 'Charlie', en: 'Charlie' },
    description: { da: 'Til den let-engagerede bruger', en: 'For light users' },
    price: 49,
    currency: 'DKK',
    voiceNotesPerMonth: 50,
    cameraNotesPerMonth: 30,
    storageMB: 1000,
    active: true,
    order: 2,
  },
  {
    id: 'tier_pro',
    displayName: { da: 'Papa', en: 'Papa' },
    description: { da: 'Fuld kraft inkl. fil-backup', en: 'Full power with file backup' },
    price: 99,
    currency: 'DKK',
    voiceNotesPerMonth: 200,
    cameraNotesPerMonth: 100,
    storageMB: 5000,
    active: true,
    order: 3,
  },
  {
    id: 'tier_unlimited',
    displayName: { da: 'Echo', en: 'Echo' },
    description: { da: 'Custom enterprise-aftale', en: 'Custom enterprise plan' },
    price: -1,
    currency: 'DKK',
    voiceNotesPerMonth: -1,
    cameraNotesPerMonth: -1,
    storageMB: -1,
    active: true,
    order: 4,
  },
]

async function seedTiers() {
  console.log('Seeder tiers til Firestore...')
  const batch = db.batch()

  for (const tier of tiers) {
    const { id, ...data } = tier
    const ref = db.collection('tiers').doc(id)
    batch.set(ref, {
      ...data,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    console.log(`  ✓ ${tier.id} (voice: ${tier.voiceNotesPerMonth}, camera: ${tier.cameraNotesPerMonth}, storage: ${tier.storageMB} MB)`)
  }

  await batch.commit()
  console.log('\n✅ Alle tiers oprettet i Firestore!')
  process.exit(0)
}

seedTiers().catch(err => {
  console.error('Fejl:', err)
  process.exit(1)
})
