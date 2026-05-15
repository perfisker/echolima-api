import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import * as fs from 'fs'
import * as path from 'path'

const serviceAccountPath = path.resolve(__dirname, '../service-account.json')
const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'))

initializeApp({ credential: cert(serviceAccount) })

const db = getFirestore()

// Tier-IDs er opaque (Arch #2 migration). Visning af navne/beskrivelser sker
// nu via displayName + description fra dette doc — ikke længere via strings.xml.
const tiers = [
  {
    id: 'tier_free',
    displayName: { da: 'Foxtrot', en: 'Foxtrot' },
    description: { da: 'For dig der vil prøve ClickTalk', en: 'For trying out' },
    price: 0,
    currency: 'DKK',
    transcriptionsPerMonth: 10,
    visionCallsPerMonth: 5,
    aiSummariesPerMonth: 5,
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
    transcriptionsPerMonth: 100,
    visionCallsPerMonth: 50,
    aiSummariesPerMonth: 50,
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
    transcriptionsPerMonth: 500,
    visionCallsPerMonth: 200,
    aiSummariesPerMonth: 200,
    storageMB: 10000,
    active: true,
    order: 3,
  },
  {
    id: 'tier_unlimited',
    displayName: { da: 'Echo', en: 'Echo' },
    description: { da: 'Custom enterprise-aftale', en: 'Custom enterprise plan' },
    price: -1,
    currency: 'DKK',
    transcriptionsPerMonth: -1,
    visionCallsPerMonth: -1,
    aiSummariesPerMonth: -1,
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
    console.log(`  ✓ ${tier.id}`)
  }

  await batch.commit()
  console.log('\n✅ Alle tiers oprettet i Firestore!')
  process.exit(0)
}

seedTiers().catch(err => {
  console.error('Fejl:', err)
  process.exit(1)
})
