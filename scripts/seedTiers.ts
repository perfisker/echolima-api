import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import * as fs from 'fs'
import * as path from 'path'

// Indlæs service account JSON
const serviceAccountPath = path.resolve(__dirname, '../../service-account.json')
const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'))

initializeApp({ credential: cert(serviceAccount) })

const db = getFirestore()

const tiers = [
  {
    id: 'foxtrot',
    name: 'EchoLima Foxtrot',
    shortName: 'Foxtrot',
    price: 0,
    currency: 'DKK',
    description: 'Kom i gang gratis',
    color: '#388E3C',
    limits: {
      transcriptionsPerMonth: 10,
      visionCallsPerMonth: 5,
      aiSummariesPerMonth: 5,
      storageMB: 100,
    },
    features: [
      '10 transskriptioner/måned',
      '5 AI-opsummeringer/måned',
      '100 MB lagerplads',
    ],
    active: true,
    order: 1,
  },
  {
    id: 'charlie',
    name: 'EchoLima Charlie',
    shortName: 'Charlie',
    price: 49,
    currency: 'DKK',
    description: 'Til den aktive bruger',
    color: '#1565C0',
    limits: {
      transcriptionsPerMonth: 100,
      visionCallsPerMonth: 50,
      aiSummariesPerMonth: 50,
      storageMB: 1000,
    },
    features: [
      '100 transskriptioner/måned',
      '50 AI-opsummeringer/måned',
      '1 GB lagerplads',
      'Prioriteret support',
    ],
    active: true,
    order: 2,
  },
  {
    id: 'papa',
    name: 'EchoLima Papa',
    shortName: 'Papa',
    price: 99,
    currency: 'DKK',
    description: 'Fuld kraft til professionelle',
    color: '#6A1B9A',
    limits: {
      transcriptionsPerMonth: 500,
      visionCallsPerMonth: 200,
      aiSummariesPerMonth: 200,
      storageMB: 10000,
    },
    features: [
      '500 transskriptioner/måned',
      '200 AI-opsummeringer/måned',
      '10 GB lagerplads',
      'Prioriteret support',
      'API-adgang',
    ],
    active: true,
    order: 3,
  },
  {
    id: 'echo',
    name: 'EchoLima Echo',
    shortName: 'Echo',
    price: -1, // Kontakt for pris
    currency: 'DKK',
    description: 'Fuld integration — du er EchoLima',
    color: '#B8860B',
    limits: {
      transcriptionsPerMonth: -1, // Ubegrænset
      visionCallsPerMonth: -1,
      aiSummariesPerMonth: -1,
      storageMB: -1,
    },
    features: [
      'Ubegrænsede transskriptioner',
      'Ubegrænsede AI-opsummeringer',
      'Ubegrænset lagerplads',
      'Dedikeret support',
      'API-adgang',
      'Custom integrationer',
    ],
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
    console.log(`  ✓ ${tier.name} (${tier.id})`)
  }

  await batch.commit()
  console.log('\n✅ Alle tiers oprettet i Firestore!')
  process.exit(0)
}

seedTiers().catch(err => {
  console.error('Fejl:', err)
  process.exit(1)
})
