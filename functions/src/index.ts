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
 *   users/{uid}/<hvad-end>/...
 *
 * Hvis dine filer ligger anderledes (fx echolima/users/{uid}/...), tilpas
 * USER_PATH_REGEX nedenfor.
 */

import { initializeApp } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'
import { getStorage } from 'firebase-admin/storage'
import { onObjectFinalized, onObjectDeleted } from 'firebase-functions/v2/storage'
import { onSchedule } from 'firebase-functions/v2/scheduler'
import { logger } from 'firebase-functions/v2'

initializeApp()

const db = getFirestore()
const APP_ID = 'echolima'
const REGION = 'europe-west1'  // Match dit Firebase-projekt-region

// Matcher fil-stier på formen "users/{uid}/..." og udtrækker uid.
// Tilpas hvis dine filer ligger under en anden prefix.
const USER_PATH_REGEX = /^users\/([^/]+)\//

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

    const usageRef = db.collection('users').doc(uid)
      .collection('usage').doc(APP_ID)

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
        // List all files for this user under users/{uid}/...
        const [files] = await bucket.getFiles({ prefix: `users/${uid}/` })

        // Sum actual bytes
        const trueBytes = files.reduce((sum, file) => {
          const fileSize = parseInt(String(file.metadata.size ?? 0), 10)
          return sum + (isNaN(fileSize) ? 0 : fileSize)
        }, 0)

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
