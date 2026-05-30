import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import * as fs from 'fs'
import * as path from 'path'

const serviceAccountPath = path.resolve(__dirname, '../service-account.json')
const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'))

initializeApp({ credential: cert(serviceAccount) })

const db = getFirestore()

// ─────────────────────────────────────────────────────────────────────────────
// Default-groups backfill (one-shot, 26. maj 2026)
//
// Architecture-WS mini-task: onUserCreated Cloud Function (deployed 26. maj 2026)
// auto-opretter default-gruppe + sætter users/{uid}.defaultGroupId for nye brugere
// fra deploy-tidspunktet. Brugere oprettet FØR triggrede aldrig onUserCreated og
// mangler derfor defaultGroupId.
//
// Dette script backfill'er disse eksisterende brugere så App-WS' create_contact-
// intent kan stoppe med at bruge fallback groupIds: [] og altid forventer
// defaultGroupId på user-doc.
//
// IDEMPOTENT: Tjekker defaultGroupId-felt før oprettelse. Flere kørsler skader
// ikke. Brugere der allerede har defaultGroupId (enten fra onUserCreated eller
// fra tidligere backfill-run) skippes stille.
//
// PAGINATION: Henter 500 brugere ad gangen for at undgå memory-issues på large
// user-bases. Hver bruger behandles i sin egen lille 2-doc-batch (group + user)
// for atomic skrivning — så fejl på én bruger blokerer ikke resten.
//
// Kør: npm run backfill:default-groups
// ─────────────────────────────────────────────────────────────────────────────

const APP_ID = 'echolima'

interface Stats {
  totalIterated: number
  skippedHasDefault: number
  createdNew: number
  errors: Array<{ uid: string; error: string }>
}

async function backfillDefaultGroups(): Promise<Stats> {
  const stats: Stats = {
    totalIterated: 0,
    skippedHasDefault: 0,
    createdNew: 0,
    errors: []
  }

  console.log('[backfill] Default-groups backfill startet...')

  const PAGE_SIZE = 500
  let lastDoc: FirebaseFirestore.QueryDocumentSnapshot | null = null

  // Paginated iteration over users-collection. Bruger startAfter(lastDoc) for
  // at undgå at hente samme docs igen ved næste page. Hvis du har < 500 brugere
  // er det effektivt ét enkelt kald.
  while (true) {
    let query = db.collection('users').orderBy('__name__').limit(PAGE_SIZE)
    if (lastDoc) query = query.startAfter(lastDoc)

    const snap = await query.get()
    if (snap.empty) break

    for (const userDoc of snap.docs) {
      stats.totalIterated++
      const uid = userDoc.id

      try {
        const data = userDoc.data()
        const existingDefaultGroupId = data?.defaultGroupId

        if (typeof existingDefaultGroupId === 'string' && existingDefaultGroupId.length > 0) {
          // Bruger har allerede defaultGroupId — skip stille
          stats.skippedHasDefault++
          console.log(`[backfill] uid=${uid} -> already has defaultGroupId=${existingDefaultGroupId}, skip`)
          continue
        }

        // Opret default-gruppe + opdater user-doc atomisk i én batch.
        // Auto-genereret ID via .doc() uden args — ingen server-call nødvendig
        // for at få ID, samme pattern som onUserCreated Cloud Function bruger.
        const groupRef = db.collection('apps').doc(APP_ID).collection('groups').doc()
        const now = Date.now()

        const batch = db.batch()
        batch.set(groupRef, {
          id: groupRef.id,
          appId: APP_ID,
          ownerUid: uid,
          name: 'Default',
          isSystem: true,
          minTier: 'tier_free',
          contactCount: 0,
          createdAt: now,
          updatedAt: now
        })
        batch.set(userDoc.ref, {
          defaultGroupId: groupRef.id
        }, { merge: true })
        await batch.commit()

        stats.createdNew++
        console.log(`[backfill] uid=${uid} -> created groupId=${groupRef.id}`)
      } catch (err: any) {
        const message = err?.message ?? String(err)
        stats.errors.push({ uid, error: message })
        console.error(`[backfill] uid=${uid} -> ERROR: ${message}`)
      }
    }

    // Hvis vi fik mindre end PAGE_SIZE i denne batch, er der ikke flere → stop
    if (snap.size < PAGE_SIZE) break
    lastDoc = snap.docs[snap.docs.length - 1]
  }

  return stats
}

backfillDefaultGroups()
  .then((stats) => {
    console.log('\n' + '═'.repeat(60))
    console.log('BACKFILL KOMPLET')
    console.log('═'.repeat(60))
    console.log(`Total users iterated:          ${stats.totalIterated}`)
    console.log(`Already had defaultGroupId:    ${stats.skippedHasDefault}`)
    console.log(`Created new default-group:     ${stats.createdNew}`)
    console.log(`Errors:                        ${stats.errors.length}`)
    if (stats.errors.length > 0) {
      console.log('\nFejl-detaljer:')
      stats.errors.forEach(e => console.log(`  uid=${e.uid}: ${e.error}`))
    }
    console.log('═'.repeat(60))
    process.exit(stats.errors.length > 0 ? 1 : 0)
  })
  .catch((err) => {
    console.error('Fatal fejl i backfill:', err)
    process.exit(1)
  })
