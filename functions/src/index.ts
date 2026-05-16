/**
 * Cloud Functions for storage-usage-tracking.
 *
 * Tre funktioner:
 *  - onStorageUpload: lytter på storage.object.finalize, incrementer
 *    user's storageBytes med fil-størrelsen.
 *  - onStorageDelete: lytter på storage.object.delete, decrementer
 *    user's storageBytes med fil-størrelsen.
 *  - reconcileStorageUsage: kører dagligt kl. 03:00 UTC, lister alle
 *    brugeres faktiske Storage-indhold og overskriver storageBytes
 *    med ground truth. Fanger drift hvis en increment/decrement fejlede.
 *
 * Forventet bucket-struktur:
 *   {prefix}/{uid}/...
 *   hvor {prefix} er én af USER_PATH_PREFIXES nedenfor.
 *
 * Tilføj nye prefixes til USER_PATH_PREFIXES hvis Android-app'en begynder at
 * uploade nye fil-typer (fx 'attachments', 'documents'). Både trigger-regex
 * og reconcile-job bygges dynamisk ud fra listen — én kilde til sandhed.
 */

import { initializeApp } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'
import { getStorage } from 'firebase-admin/storage'
import { onObjectFinalized, onObjectDeleted } from 'firebase-functions/v2/storage'
import { onSchedule } from 'firebase-functions/v2/scheduler'
import { logger } from 'firebase-functions/v2'
// v1 Auth-trigger er stadig den eneste måde at lytte på Auth user.delete() i
// Firebase Functions (v2 Identity Platform-triggers er paid-tier-only og har
// kun blocking before-triggers, ikke after-delete-events).
// NB: v1 Auth-triggers deployer kun til us-central1 — ikke vores europe-west1.
// Det er fint for cleanup: cross-region Firestore/Storage-kald koster ~50ms
// ekstra latency, men cleanup er bruger-usynlig så det betyder intet.
import { auth as authV1 } from 'firebase-functions/v1'

initializeApp()

const db = getFirestore()
const APP_ID = 'echolima'
const REGION = 'europe-west1'  // Match dit Firebase-projekt-region

// Top-level-mapper Android-app'en uploader til. Hver fil forventes at ligge
// på formen "{prefix}/{uid}/...", hvor {prefix} matcher én af disse.
// Tilføj nye prefixes her når Android-app'en udvider.
const USER_PATH_PREFIXES = ['audio', 'images']

// Dynamisk regex bygget fra prefix-listen. Matcher fx "audio/{uid}/..." eller
// "images/{uid}/..." og udtrækker uid'et i capture-gruppen.
const USER_PATH_REGEX = new RegExp(
  `^(?:${USER_PATH_PREFIXES.join('|')})\\/([^/]+)\\/`
)

function extractUid(filePath: string | undefined): string | null {
  if (!filePath) return null
  const match = filePath.match(USER_PATH_REGEX)
  return match ? match[1] : null
}

/**
 * Fires når en fil er fuldt uploadet til Firebase Storage.
 * Atomic increment af user's storageBytes-counter.
 */
export const onStorageUpload = onObjectFinalized(
  { region: REGION },
  async (event) => {
    const filePath = event.data.name
    const sizeStr = event.data.size
    const size = sizeStr ? parseInt(String(sizeStr), 10) : NaN

    if (!filePath || !size || isNaN(size) || size <= 0) {
      logger.warn(`onStorageUpload: skipping invalid event`, { filePath, sizeStr })
      return
    }

    const uid = extractUid(filePath)
    if (!uid) {
      logger.warn(`onStorageUpload: cannot extract uid from path: ${filePath}`)
      return
    }

    const usageRef = db.collection('users').doc(uid)
      .collection('usage').doc(APP_ID)

    // Brug set+merge så vi ikke fejler hvis usage-doc'et endnu ikke findes
    // (fx ved første upload før /auth/sync har kørt).
    await usageRef.set(
      { storageBytes: FieldValue.increment(size) },
      { merge: true }
    )

    logger.info(`Storage +${size} bytes for ${uid}`, { filePath })
  }
)

/**
 * Fires når en fil slettes fra Firebase Storage.
 * Atomic decrement af user's storageBytes-counter.
 *
 * Note: hvis Cloud Function aldrig kørte ved upload (fx hvis Storage-rules
 * blokerede increment, eller hvis denne function blev deployet efter filen
 * blev oprettet), kan decrementen sende storageBytes ned under 0.
 * Reconcile-jobbet fanger og fixer det.
 */
export const onStorageDelete = onObjectDeleted(
  { region: REGION },
  async (event) => {
    const filePath = event.data.name
    const sizeStr = event.data.size
    const size = sizeStr ? parseInt(String(sizeStr), 10) : NaN

    if (!filePath || !size || isNaN(size) || size <= 0) {
      logger.warn(`onStorageDelete: skipping invalid event`, { filePath, sizeStr })
      return
    }

    const uid = extractUid(filePath)
    if (!uid) {
      logger.warn(`onStorageDelete: cannot extract uid from path: ${filePath}`)
      return
    }

    // Race-condition guard mod GDPR cascade-cleanup:
    // Hvis user-doc'et lige er blevet slettet af onUserDelete, men Storage-
    // delete-eventet kommer ind bagefter (asynkron natur), så ville en
    // set+merge genskabe et orphan usage-doc med negativ storageBytes der
    // hænger uden ejer. Tjek doc-eksistens først og skip stille.
    const userRef = db.collection('users').doc(uid)
    const userSnap = await userRef.get()
    if (!userSnap.exists) {
      logger.info(`onStorageDelete: user-doc væk for ${uid} (sandsynligvis sletning i gang), skipper`)
      return
    }

    const usageRef = userRef.collection('usage').doc(APP_ID)
    await usageRef.set(
      { storageBytes: FieldValue.increment(-size) },
      { merge: true }
    )

    logger.info(`Storage -${size} bytes for ${uid}`, { filePath })
  }
)

/**
 * Schedulerede daglig reconcile-job.
 *
 * Lister alle brugeres filer i Firebase Storage og sætter storageBytes
 * lig med ground truth. Fanger evt. drift fra fejlede increment/decrement-
 * events eller fra filer der blev uploadet før denne function blev deployet.
 *
 * Køres kl. 03:00 UTC (~04:00 dansk vintertid, 05:00 sommertid) hvor
 * brugeraktivitet er lav.
 *
 * timeoutSeconds: 540 (9 min) er max for scheduled functions. Hvis du
 * får mange brugere (~10K+), skal dette splittes op i pagineret batch-job.
 */
export const reconcileStorageUsage = onSchedule(
  {
    schedule: '0 3 * * *',
    region: REGION,
    timeoutSeconds: 540,
    memory: '512MiB',
  },
  async () => {
    const bucket = getStorage().bucket()
    const usersSnap = await db.collection('users').get()

    let totalUsers = 0
    let driftedUsers = 0

    for (const userDoc of usersSnap.docs) {
      const uid = userDoc.id
      totalUsers++

      try {
        // List all files for this user across all known prefixes
        // (audio/{uid}/..., images/{uid}/..., osv.) og summér samlet størrelse.
        let trueBytes = 0
        for (const prefix of USER_PATH_PREFIXES) {
          const [files] = await bucket.getFiles({ prefix: `${prefix}/${uid}/` })
          trueBytes += files.reduce((sum, file) => {
            const fileSize = parseInt(String(file.metadata.size ?? 0), 10)
            return sum + (isNaN(fileSize) ? 0 : fileSize)
          }, 0)
        }

        // Compare to Firestore
        const usageRef = db.collection('users').doc(uid)
          .collection('usage').doc(APP_ID)
        const usageSnap = await usageRef.get()
        const currentBytes = usageSnap.data()?.storageBytes ?? 0

        if (currentBytes !== trueBytes) {
          await usageRef.set(
            { storageBytes: trueBytes },
            { merge: true }
          )
          driftedUsers++
          logger.info(`Reconciled ${uid}: ${currentBytes} → ${trueBytes} bytes (drift ${trueBytes - currentBytes})`)
        }
      } catch (err) {
        logger.error(`Reconcile failed for ${uid}:`, err)
        // Continue with next user — don't crash whole job on one bad user
      }
    }

    logger.info(`Reconciliation complete: ${totalUsers} users, ${driftedUsers} corrected`)
  }
)

/**
 * GDPR cascade-cleanup ved Auth user-deletion.
 *
 * Fyrer når en Firebase Auth-bruger slettes via "Slet konto og alle data"-
 * link'et i Android-app'en (klienten kalder user.delete() efter at have
 * ryddet lokal Room + filesDir).
 *
 * Klienten sletter:
 *   - Firestore: users/{uid} + subcollections (notes, contacts, tags, usage)
 *   - Firebase Auth: user.delete()
 *   - Lokal: Room-database + filesDir
 *
 * Klienten sletter IKKE:
 *   - Firebase Storage-filer (audio/{uid}/, images/{uid}/)
 *   - events/-docs med matching uid (usage-tracking, ikke under users/)
 *
 * Denne trigger fanger de manglende stykker og er samtidig defensiv backup
 * hvis klient-deletion blev afbrudt midt-flow (network-drop, app-crash).
 * Alt er idempotent: gentagen kørsel skader ikke.
 *
 * Stripe-customer slettes IKKE her — finansielle records har typisk legal
 * retention (skatteregnskab), og Cloud Functions har ikke Stripe SDK
 * configureret. Hvis bruger har aktiv sub bør Android-app'en cancel'e den
 * EKSPLICIT inden konto-deletion.
 */
export const onUserDelete = authV1.user().onDelete(async (user) => {
  const uid = user.uid
  logger.info(`[onUserDelete] GDPR cascade-cleanup startet for uid=${uid}`)

  const db = getFirestore()
  const bucket = getStorage().bucket()

  // ─── 1. Slet Storage-filer på tværs af alle USER_PATH_PREFIXES parallelt ───
  // Promise.allSettled fortsætter med resten hvis én prefix fejler. Hver
  // bucket.deleteFiles() er rekursiv og håndterer pagination internt.
  await Promise.allSettled(
    USER_PATH_PREFIXES.map(async (prefix) => {
      try {
        await bucket.deleteFiles({ prefix: `${prefix}/${uid}/` })
        logger.info(`[onUserDelete] Storage cleared: ${prefix}/${uid}/`)
      } catch (err) {
        logger.error(`[onUserDelete] Storage cleanup fejlede: ${prefix}/${uid}/`, err)
        throw err  // re-throw så allSettled markerer som rejected
      }
    })
  )

  // ─── 2. Slet Firestore user-doc + alle subcollections ───
  // recursiveDelete håndterer pagination + subcollection-discovery automatisk.
  // Hvis klienten allerede har slettet det meste, er det idempotent.
  try {
    await db.recursiveDelete(db.collection('users').doc(uid))
    logger.info(`[onUserDelete] Firestore user-doc + subcollections slettet: ${uid}`)
  } catch (err) {
    logger.error(`[onUserDelete] Firestore user-cleanup fejlede for ${uid}:`, err)
  }

  // ─── 3. Slet events/ docs hvor uid matcher ───
  // Tracking-data fra POST /usage/record. Pagineret for at undgå Firestore's
  // 500-doc batch-grænse ved heavy users.
  try {
    const eventsRef = db.collection('events')
    let deletedEvents = 0
    while (true) {
      const snap = await eventsRef.where('uid', '==', uid).limit(500).get()
      if (snap.empty) break
      const batch = db.batch()
      snap.docs.forEach(doc => batch.delete(doc.ref))
      await batch.commit()
      deletedEvents += snap.size
      if (snap.size < 500) break
    }
    logger.info(`[onUserDelete] Events slettet: ${deletedEvents} for ${uid}`)
  } catch (err) {
    logger.error(`[onUserDelete] Events-cleanup fejlede for ${uid}:`, err)
  }

  logger.info(`[onUserDelete] Cleanup gennemført for uid=${uid}`)
})
