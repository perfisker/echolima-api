import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { AppDoc, Capabilities } from '../src/types'
import * as fs from 'fs'
import * as path from 'path'

const serviceAccountPath = path.resolve(__dirname, '../service-account.json')
const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'))

initializeApp({ credential: cert(serviceAccount) })

const db = getFirestore()

// ─────────────────────────────────────────────────────────────────────────────
// App-definitioner
//
// apps/{appId} er et nyt Firestore-niveau introduceret i capabilities-runden
// (17. maj 2026). Det holder app-globale capabilities (commonCapabilities) der
// er tilgængelige på tværs af ALLE niches for det pågældende app.
//
// Eksempler på app-globale voice commands (Fase 2, ikke seeded her endnu):
//   - "AI-forslag"                → rerun_analysis_with_suffix
//   - "Hvilke kategorier kan jeg sige?" → local_ui: show_capability_list
//   - "PII-shield"                → set_metadata_flag: pii_detected
//
// Se EchoLima_Niche_Capabilities_Architecture.md §3 (Q2) for merge-semantik.
// ─────────────────────────────────────────────────────────────────────────────

const emptyCapabilities: Capabilities = {
  extraFields: [],
  voiceCommands: [],
  metadataFlags: []
}

const apps: Array<Omit<AppDoc, 'id'> & { id: string }> = [
  {
    id: 'echolima',
    displayName: { da: 'EchoLima', en: 'EchoLima' },
    commonCapabilities: emptyCapabilities
    // Fase 2: fyld voiceCommands med app-globale kommandoer (AI-forslag, PII-shield, hvad-kan-jeg-sige)
  }
]

async function seedApps() {
  console.log('Seeder apps til Firestore...')
  const batch = db.batch()

  for (const app of apps) {
    const { id, ...data } = app
    const ref = db.collection('apps').doc(id)

    // merge: true bevarer eksisterende felter (bundleId, platform, version osv.)
    // som evt. allerede er sat af /apps POST-endpoint. Vi skriver kun/primært
    // commonCapabilities og displayName — resten berøres ikke.
    batch.set(ref, {
      ...data,
      updatedAt: Date.now()
    }, { merge: true })

    console.log(`  ✓ ${id.padEnd(15)} (commonCapabilities: ${Object.keys(data.commonCapabilities ?? {}).join(', ')})`)
  }

  await batch.commit()
  console.log(`\n✅ ${apps.length} app(s) oprettet/opdateret i Firestore!`)
  console.log('\nNæste skridt (Fase 2):')
  console.log('  Fyld commonCapabilities.voiceCommands med app-globale kommandoer')
  console.log('  Se EchoLima_Niche_Capabilities_Architecture.md §7 (Fase 2)')
  process.exit(0)
}

seedApps().catch(err => {
  console.error('Fejl:', err)
  process.exit(1)
})
