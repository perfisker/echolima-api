import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { AppDoc, Capabilities, VoiceCommandDef, MetadataFlagDef, ExtraFieldDef } from '../src/types'
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
// Fase 2 (22. maj 2026): commonCapabilities er nu populeret med:
//   - 3 voiceCommands: ai_suggestions, list_capabilities, pii_shield_flag
//   - 1 metadataFlag: pii_detected (autoDetect: true — backend sætter via PII-pipeline)
//   - 0 extraFields: alle extraFields er per-niche (ingen app-globale i V1)
//
// Se EchoLima_Niche_Capabilities_Architecture.md §3 (Q2) for merge-semantik.
// ─────────────────────────────────────────────────────────────────────────────

// ─── App-globale voice commands ──────────────────────────────────────────────
const commonVoiceCommands: VoiceCommandDef[] = [
  {
    // Kræver ekstra OpenAI-kald → tier_basic+
    id: 'ai_suggestions',
    triggers: {
      da: ['ai forslag', 'giv mig forslag', 'hvad foreslår du', 'forslag tak'],
      en: ['ai suggestions', 'give me suggestions', 'what do you suggest', 'suggestions please']
    },
    action: {
      type: 'rerun_analysis_with_suffix',
      params: {
        suffix: 'Brugeren har eksplicit bedt om yderligere AI-forslag til denne note. Generer 3-5 konkrete, kreative og handlingsorienterede forslag der bredder noten — ikke bare to-dos, men også nye perspektiver, alternative formuleringer, oversete vinkler eller næste skridt brugeren ikke har overvejet endnu. Vær konstruktiv og specifik. Returnér KUN feltet \'suggested_improvements\' i din JSON-respons som et array af strings.',
        fieldsToOverwrite: ['suggested_improvements']
      }
    },
    minTier: 'tier_basic',
    description: {
      da: 'Få AI til at foreslå forbedringer og nye vinkler på noten',
      en: 'Get AI to suggest improvements and new angles on the note'
    }
  },
  {
    // Lokal operation — ingen tier-krav
    id: 'list_capabilities',
    triggers: {
      da: ['hvilke kommandoer kan jeg sige', 'hvad kan du', 'hjælp', 'liste kommandoer'],
      en: ['what commands can i say', 'what can you do', 'help', 'list commands']
    },
    action: {
      type: 'local_ui',
      params: {
        view: 'capability_list'
      }
    },
    description: {
      da: 'Vis listen over voice commands der er tilgængelige lige nu',
      en: 'Show the list of voice commands available right now'
    }
  },
  {
    // Lokal metadata-flag — ingen tier-krav
    id: 'pii_shield_flag',
    triggers: {
      da: ['pii shield', 'beskyt persondata', 'marker som følsom', 'flag som pii'],
      en: ['pii shield', 'protect personal data', 'mark as sensitive', 'flag as pii']
    },
    action: {
      type: 'set_metadata_flag',
      params: {
        flagId: 'pii_detected',
        source: 'voice_command'
      }
    },
    description: {
      da: 'Marker manuelt at noten indeholder persondata (GDPR-bevidst)',
      en: 'Manually mark that the note contains personal data (GDPR-aware)'
    }
  }
]

// ─── App-globale metadata flags ───────────────────────────────────────────────
const commonMetadataFlags: MetadataFlagDef[] = [
  {
    id: 'pii_detected',
    displayName: { da: 'Indeholder persondata', en: 'Contains personal data' },
    visualHint: { color: '#E54F4F', icon: 'shield_alert' },
    autoDetect: true   // Backend's PII-pipeline (regex + AI) sætter denne automatisk
  }
  // Fremtidige flags identificeret men IKKE aktiveret i V1:
  // { id: 'retention_30d', ... }   — 30-dages PII-retention reminder (kræver Cloud Function)
  // { id: 'sensitive_business', ... } — forretningskritiske noter (kræver Pro+-feature)
]

// ─── App-globale extraFields ──────────────────────────────────────────────────
// Tom i V1 — alle extraFields er per-niche.
const commonExtraFields: ExtraFieldDef[] = []

const commonCapabilities: Capabilities = {
  extraFields: commonExtraFields,
  voiceCommands: commonVoiceCommands,
  metadataFlags: commonMetadataFlags
}

const apps: Array<Omit<AppDoc, 'id'> & { id: string }> = [
  {
    id: 'echolima',
    displayName: { da: 'EchoLima', en: 'EchoLima' },
    commonCapabilities
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
  console.log('\nFase 2 seeded:')
  console.log(`  commonCapabilities.voiceCommands: ${commonVoiceCommands.length} entries (${commonVoiceCommands.map(c => c.id).join(', ')})`)
  console.log(`  commonCapabilities.metadataFlags: ${commonMetadataFlags.length} entries (${commonMetadataFlags.map(f => f.id).join(', ')})`)
  console.log(`  commonCapabilities.extraFields: ${commonExtraFields.length} entries (tom — alle extraFields er per-niche)`)
  process.exit(0)
}

seedApps().catch(err => {
  console.error('Fejl:', err)
  process.exit(1)
})
