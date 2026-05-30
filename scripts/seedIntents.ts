import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { IntentDef } from '../src/types'
import * as fs from 'fs'
import * as path from 'path'

const serviceAccountPath = path.resolve(__dirname, '../service-account.json')
const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'))

initializeApp({ credential: cert(serviceAccount) })

const db = getFirestore()

// ─────────────────────────────────────────────────────────────────────────────
// V1-intents
//
// create_tag    — V1.1 POC. Ét slot (name), continuation extraction.
// create_contact — V1.2 multi-turn. To required slots (name, email) + optional
//                  phone. Hybrid extraction (continuation først, NLU fallback).
//
// Alle intents er gratis for alle tiers (Beslutning #5 i Architecture-doc).
// Lever i apps/echolima.commonCapabilities.intents (app-globalt, ikke per-niche).
//
// V1.3 send_email tilføjes i separat seed-iteration efter NLU-template-forbedring
// (kræver few-shot eksempler for content_ref-semantik).
// ─────────────────────────────────────────────────────────────────────────────

const v1Intents: IntentDef[] = [
  // ─── create_tag — V1.1 POC ─────────────────────────────────────────────────
  // Enkleste mulige intent: ét required slot via continuation extraction.
  // Formål: Proof-of-concept der validerer hele infrastrukturen end-to-end
  // (trigger-match → slot-extraction → preview_dialog → POST /tags → tag oprettet)
  // INDEN vi investerer i multi-turn-logik for create_contact.
  {
    id: 'create_tag',
    triggers: {
      da: ['opret tag', 'ny tag', 'tilføj tag', 'lav tag'],
      en: ['create tag', 'new tag', 'add tag']
    },
    slots: [
      {
        id: 'name',
        type: 'string',
        required: true,
        extract: 'continuation',
        if_missing: 'ask',
        description: { da: 'tag-navnet', en: 'the tag name' }
      }
    ],
    extraction: 'continuation',
    action: {
      type: 'invoke_endpoint',
      params: {
        endpoint: '/tags',
        method: 'POST',
        bodyTemplate: { name: '${name}' }
      }
    },
    confirmation: 'preview_dialog',
    description: {
      da: 'Opret en ny tag du kan bruge på noter',
      en: 'Create a new tag for your notes'
    }
  },

  // ─── create_contact — V1.2 multi-turn ──────────────────────────────────────
  // To required slots (name + email) + optional phone.
  // ASK-once-then-fail: hvis email mangler → spørg én gang → hvis stadig mangler → fejl.
  //
  // R1 NOTE: groupIds i bodyTemplate bruger '${default_group_id}' som placeholder.
  // Dette er et KLIENT-SIDE template — Android substituerer det med det cachede
  // default-group-ID inden POST. Backend modtager aldrig denne string — den ser
  // et resolved groupIds: ['<actual-firestore-id>']. Backend behandler groupIds
  // som ethvert andet optional string[]-felt.
  {
    id: 'create_contact',
    triggers: {
      da: ['opret kontakt', 'ny kontakt', 'tilføj kontakt'],
      en: ['create contact', 'new contact', 'add contact']
    },
    slots: [
      {
        id: 'name',
        type: 'string',
        required: true,
        extract: 'hybrid',
        if_missing: 'ask',
        description: { da: 'kontaktens navn', en: "contact's name" }
      },
      {
        id: 'email',
        type: 'email',
        required: true,
        extract: 'hybrid',
        if_missing: 'ask',
        description: { da: 'kontaktens email', en: "contact's email" },
        validation: { pattern: '^[\\w._%+-]+@[\\w.-]+\\.[A-Za-z]{2,}$' }
      },
      {
        id: 'phone',
        type: 'phone',
        required: false,
        extract: 'hybrid',
        description: { da: 'telefon (valgfri)', en: 'phone (optional)' }
      }
    ],
    extraction: 'hybrid',
    action: {
      type: 'invoke_endpoint',
      params: {
        endpoint: '/contacts',
        method: 'POST',
        // ${default_group_id} er KLIENT-SIDE placeholder — se R1 NOTE ovenfor.
        // Android substituerer med cachet default-group-ID før POST.
        bodyTemplate: {
          name: '${name}',
          email: '${email}',
          phone: '${phone}',
          groupIds: ['${default_group_id}']
        }
      }
    },
    confirmation: 'preview_dialog',
    description: {
      da: 'Opret en ny kontakt i din kontaktbog',
      en: 'Create a new contact'
    }
  },

  // ─── send_email — V1.3 ──────────────────────────────────────────────────────
  // Email-compose med NLU-extracted recipient + content_ref.
  //
  // recipient_ref: modtagerens navn (NLU). Backend resolver til email via
  //   users/{uid}/contacts case-insensitive name-match. Hvis recipient_ref
  //   tilfældigvis ER en email, sendes der direkte til den (defensiv fallback).
  //
  // content_ref: union 'all' | 'summary' | number[] | <extraFieldId>
  //   Android sender noteContent med noten — backend bygger email-body ud fra
  //   content_ref. Default = 'all' hvis intet nævnes (se NLU few-shot eksempel 4).
  //
  // ${default_group_id} bruges IKKE her — sender til specifik kontakt, ikke gruppe.
  {
    id: 'send_email',
    triggers: {
      da: ['send email', 'send noter', 'email til', 'send til', 'send resumé', 'mail til'],
      en: ['send email', 'send notes', 'email to', 'send to']
    },
    slots: [
      {
        id: 'recipient_ref',
        type: 'recipient_ref',
        required: true,
        extract: 'nlu',
        if_missing: 'ask',
        description: { da: 'modtageren (navn fra kontaktbog)', en: 'recipient (name from contacts)' }
      },
      {
        id: 'content_ref',
        type: 'content_ref',
        required: false,
        extract: 'nlu',
        default: 'all',
        description: { da: 'hvilken del af noten der sendes', en: 'which part of the note to send' }
      }
    ],
    extraction: 'nlu',
    action: {
      type: 'invoke_endpoint',
      params: {
        endpoint: '/email/compose-send',
        method: 'POST',
        bodyTemplate: {
          recipient_ref: '${recipient_ref}',
          content_ref: '${content_ref}'
        }
      }
    },
    confirmation: 'preview_dialog',
    description: {
      da: 'Send noter eller resumé til en kontakt via email',
      en: 'Send notes or summary to a contact by email'
    }
  }
]

async function seedIntents() {
  console.log('Seeder V1-intents til Firestore (apps/echolima.commonCapabilities.intents)...')

  const ref = db.collection('apps').doc('echolima')
  await ref.set({
    commonCapabilities: {
      intents: v1Intents
    },
    updatedAt: Date.now()
  }, { merge: true })

  console.log(`\n✅ ${v1Intents.length} intents seeded:`)
  v1Intents.forEach(i =>
    console.log(`  ✓ ${i.id.padEnd(20)} (slots: ${i.slots.length}, extraction: ${i.extraction})`)
  )
  console.log('\nNæste skridt: invalidér intent-cache i prod ved at restarte Render-service,')
  console.log('eller vent 5 min på automatisk cache-udløb.')
  process.exit(0)
}

seedIntents().catch(err => {
  console.error('Fejl:', err)
  process.exit(1)
})
