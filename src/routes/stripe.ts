import { Router, Request, Response } from 'express'
import Stripe from 'stripe'
import { getFirestore } from 'firebase-admin/firestore'
import { getAuth } from 'firebase-admin/auth'
import { verifyToken } from '../middleware/auth'
import { AuthRequest } from '../types'

const router = Router()

function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) throw new Error('STRIPE_SECRET_KEY er ikke sat')
  return new Stripe(key)
}

// Mapning fra tierId → Stripe Price ID
// NB: env-vars omdøbt fra STRIPE_PRICE_CHARLIE/PAPA til STRIPE_PRICE_BASIC/PRO
// som del af Arch #2 (opaque tier-IDs). Husk at omdøbe på Render dashboard.
function getPriceId(tierId: string): string {
  const map: Record<string, string | undefined> = {
    tier_basic: process.env.STRIPE_PRICE_BASIC,
    tier_pro:   process.env.STRIPE_PRICE_PRO,
  }
  const priceId = map[tierId]
  if (!priceId) throw new Error(`Ingen Stripe price ID for tier: ${tierId}`)
  return priceId
}

// Mapning fra Stripe Price ID → tierId (omvendt opslag)
function getTierIdFromPriceId(priceId: string): string | null {
  const map: Record<string, string> = {}
  if (process.env.STRIPE_PRICE_BASIC) map[process.env.STRIPE_PRICE_BASIC] = 'tier_basic'
  if (process.env.STRIPE_PRICE_PRO)   map[process.env.STRIPE_PRICE_PRO]   = 'tier_pro'
  return map[priceId] ?? null
}

/**
 * Hent current_period_end fra et Stripe Subscription-objekt.
 *
 * current_period_end er typet som number på Subscription top-niveau,
 * men kan ved runtime returnere 0 eller NaN ved API-version mismatch.
 * Denne hjælpefunktion returnerer altid et gyldigt tal eller null.
 */
function getPeriodEnd(subscription: Stripe.Subscription): number | null {
  const periodEnd = subscription.current_period_end
  if (periodEnd && !isNaN(periodEnd) && periodEnd > 0) return periodEnd * 1000

  // Fallback: cancel_at hvis abonnementet er ved at udløbe
  if (subscription.cancel_at && subscription.cancel_at > 0) return subscription.cancel_at * 1000

  return null
}

/**
 * Sørger for at user-doc'et for `uid` har de basale profil-felter
 * (uid, email, displayName, photoURL, createdAt, lastSeen, locale, tierId)
 * FØR webhook-handleren begynder at skrive Stripe-felter.
 *
 * Hvis doc'et allerede findes, røres det ikke — eksisterende felter overskrives ikke.
 * Hvis det ikke findes, hentes profil-data via Firebase Auth og doc'et oprettes
 * med samme shape som auth.ts /sync, plus en tom usage/echolima subcollection.
 *
 * Defensiv tierId='tier_free' så reads mellem init og det efterfølgende Stripe-set
 * altid har en gyldig tier. Stripe-handleren overskriver dette straks efter via merge.
 *
 * Fix for Bug A: tidligere skrev webhook'en kun {tierId, stripeCustomerId, updatedAt}
 * via merge på et tomt doc, hvilket efterlod uid/email/displayName/photoURL/createdAt
 * /locale tomme. AuthViewModel'ens efterfølgende /sync så at doc eksisterede og
 * opdaterede kun lastSeen — uden at backfill'e.
 */
async function ensureUserDocInitialized(uid: string): Promise<void> {
  const db = getFirestore()
  const userRef = db.collection('users').doc(uid)
  const snap = await userRef.get()
  if (snap.exists) return

  let email = ''
  let displayName = ''
  let photoURL = ''
  try {
    const userRecord = await getAuth().getUser(uid)
    email       = userRecord.email ?? ''
    displayName = userRecord.displayName ?? ''
    photoURL    = userRecord.photoURL ?? ''
  } catch (err) {
    // Firebase Auth-bruger findes ikke endnu — sker hvis Stripe-checkout fyrer
    // FØR brugeren har gennemført Google Sign-In. Vi initialiserer alligevel
    // doc'et med tomme strenge; auth.ts /sync kan backfill'e senere.
    console.warn(`ensureUserDocInitialized: kunne ikke hente Auth-profil for ${uid}:`, err)
  }

  const now = Date.now()
  await userRef.set({
    uid,
    email,
    displayName,
    photoURL,
    tierId: 'tier_free',
    createdAt: now,
    lastSeen: now,
    locale: 'da'
  })
  await userRef.collection('usage').doc('echolima').set({
    transcriptions: 0,
    visionCalls: 0,
    aiSummaries: 0,
    storageBytes: 0,
    resetAt: now
  })
  console.log(`User-doc initialiseret via Stripe-webhook: ${uid}`)
}

/**
 * Tier-prioritet baseret på `order`-feltet i seedTiers.ts.
 * Bruges til at finde den højeste aktive tier blandt en customer's
 * resterende Stripe-subscriptions før vi degraderer ved
 * customer.subscription.deleted eller invoice.payment_failed.
 */
const TIER_PRIORITY: Record<string, number> = {
  tier_free: 1,
  tier_basic: 2,
  tier_pro: 3,
  tier_unlimited: 4
}

/**
 * Returnerer den højeste aktive subscription på `customerId` (tier + sub-objekt),
 * eller null hvis ingen andre aktive subs findes.
 *
 * `excludeSubId` filtrerer den subscription der lige er blevet slettet eller
 * har fået payment_failed fra resultatet — defensivt, selvom status:'active'-
 * filteret normalt allerede ekskluderer canceled/past_due/incomplete.
 *
 * Fix for Bug B: tidligere blev tier nulstillet til 'foxtrot' uden at tjekke
 * om customer havde andre aktive subs. Bruger med Charlie+Papa der cancelede
 * Papa blev fejlagtigt degraderet til foxtrot selvom Charlie var aktiv.
 */
async function getHighestActiveTier(
  stripe: Stripe,
  customerId: string,
  excludeSubId?: string
): Promise<{ tierId: string; subscription: Stripe.Subscription } | null> {
  const subs = await stripe.subscriptions.list({
    customer: customerId,
    status: 'active',
    limit: 5
  })
  let best: { tierId: string; subscription: Stripe.Subscription; priority: number } | null = null
  for (const sub of subs.data) {
    if (excludeSubId && sub.id === excludeSubId) continue
    const priceId = sub.items.data[0]?.price?.id
    const tierId = priceId ? getTierIdFromPriceId(priceId) : null
    if (!tierId) continue
    const priority = TIER_PRIORITY[tierId] ?? 0
    if (!best || priority > best.priority) {
      best = { tierId, subscription: sub, priority }
    }
  }
  if (!best) return null
  return { tierId: best.tierId, subscription: best.subscription }
}

// POST /stripe/create-checkout-session
//
// Bug-fix (23. maj 2026): tidligere oprettede dette endpoint ALTID en ny
// Stripe Checkout Session uden at tjekke om brugeren allerede havde en
// aktiv subscription. Det betød at hvert "Upgrade"-klik resulterede i
// en ny subscription oven i de eksisterende → bruger blev opkrævet
// flere gange for samme produkt (se Stripe-dashboard 22.-23. maj 2026).
//
// Ny adfærd:
//   1. Tjek for active subscription på customer.
//   2. Active sub med ANDET price-ID → kald stripe.subscriptions.update()
//      med nyt price. Stripe håndterer proration automatisk. Webhook
//      'customer.subscription.updated' opdaterer tier i Firestore.
//      Returnerer { url: STRIPE_SUCCESS_URL } for backward-compat med
//      Android-klient — den behøver ikke vide forskel på checkout vs.
//      in-place upgrade.
//   3. Active sub med SAMME price-ID → 400 'already_subscribed'.
//   4. Ingen active sub → eksisterende checkout-flow (uændret).
//
// Hvis du senere vil flytte upgrade-logik til separat endpoint
// (fx /stripe/change-plan), så hold dette her som ren first-time-
// checkout. Indtil da er det acceptabelt at ét endpoint dækker
// begge cases — det matcher Android's nuværende kald.
router.post('/create-checkout-session', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const { tierId } = req.body
    if (!tierId || typeof tierId !== 'string') {
      res.status(400).json({ error: 'missing_tier_id', message: 'Mangler tierId' })
      return
    }
    const stripe = getStripe()
    const priceId = getPriceId(tierId)
    const uid = req.user?.uid
    if (!uid) { res.status(401).json({ error: 'unauthenticated', message: 'Ikke autoriseret' }); return }

    const successUrl = process.env.STRIPE_SUCCESS_URL ?? 'https://api.echolima.app/payment/success'
    const cancelUrl  = process.env.STRIPE_CANCEL_URL  ?? 'https://api.echolima.app/payment/cancel'

    // Hent evt. eksisterende Stripe kunde-ID så vi genbruger kunden
    const db = getFirestore()
    const userDoc = await db.collection('users').doc(uid).get()
    const existingCustomerId = userDoc.data()?.stripeCustomerId

    // ─── Check for active subscription ───
    // Hvis customer findes på Stripe-side, tjek for active subs FØR vi
    // overhovedet overvejer at oprette en ny checkout-session.
    if (existingCustomerId) {
      const activeSubs = await stripe.subscriptions.list({
        customer: existingCustomerId,
        status: 'active',
        limit: 10
      })

      if (activeSubs.data.length > 0) {
        // Brugeren har mindst én aktiv subscription. Find den med højeste
        // tier-prioritet (samme helper som webhook-handleren bruger ved
        // degradation). Det undgår at vi vælger en lavere-tier sub hvis
        // brugeren midlertidigt har flere (cleanup-edge case).
        const highest = await getHighestActiveTier(stripe, existingCustomerId)
        const targetSub = highest?.subscription ?? activeSubs.data[0]
        const currentPriceId = targetSub.items.data[0]?.price?.id
        const currentTierId  = highest?.tierId ?? (currentPriceId ? getTierIdFromPriceId(currentPriceId) : null)

        // Same tier → afvis (forhindrer dobbelt-køb af samme produkt)
        if (currentPriceId === priceId) {
          res.status(400).json({
            error: 'already_subscribed',
            message: `Du har allerede aktivt ${tierId}-abonnement. Brug Customer Portal til at administrere det.`,
            currentTierId
          })
          return
        }

        // Andet tier → in-place upgrade via subscriptions.update.
        // proration_behavior='create_prorations' = standard: Stripe krediterer
        // ubrugt tid på nuværende plan og opkræver differencen til nyt plan.
        const subscriptionItemId = targetSub.items.data[0]?.id
        if (!subscriptionItemId) {
          // Defensive: hvis subscription mangler items (skulle aldrig ske
          // for aktiv sub), fall back til checkout for at undgå crash.
          console.warn(`stripe/create-checkout-session: active sub ${targetSub.id} mangler items — falder tilbage til checkout`)
        } else {
          await stripe.subscriptions.update(targetSub.id, {
            items: [{
              id: subscriptionItemId,
              price: priceId
            }],
            proration_behavior: 'create_prorations',
            metadata: { uid, tierId }
          })

          console.log(`Stripe in-place upgrade: ${uid} fra ${currentTierId} til ${tierId} (sub ${targetSub.id})`)

          // Returner success-URL så Android-klienten kan navigere til
          // bekræftelsessiden. Webhook 'customer.subscription.updated' har
          // allerede (eller vil snart) opdatere tier i Firestore.
          res.json({ url: successUrl })
          return
        }
      }
    }

    // ─── Ingen active sub → first-time checkout flow ───
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer: existingCustomerId ?? undefined,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { uid, tierId },
      subscription_data: { metadata: { uid, tierId } },
    })
    res.json({ url: session.url })
  } catch (err) {
    console.error('stripe/create-checkout-session fejl:', err)
    res.status(500).json({ error: 'checkout_session_failed', message: 'Kunne ikke oprette betalingssession' })
  }
})

// POST /stripe/webhook
router.post('/webhook', async (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature']
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET
  if (!sig || !webhookSecret) {
    res.status(400).json({ error: 'Mangler webhook signatur eller secret' })
    return
  }

  let event: Stripe.Event
  try {
    const stripe = getStripe()
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret)
  } catch (err) {
    console.error('Stripe webhook signatur fejl:', err)
    res.status(400).json({ error: 'Ugyldig webhook signatur' })
    return
  }

  const db = getFirestore()
  try {
    switch (event.type) {

      // Ny checkout gennemført → sæt tier med det samme
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session
        const uid    = session.metadata?.uid
        const tierId = session.metadata?.tierId
        if (uid && tierId) {
          // Bug A fix: initialisér user-doc fuldt FØR vi merger Stripe-felter ind
          await ensureUserDocInitialized(uid)
          await db.collection('users').doc(uid).set(
            {
              tierId,
              stripeCustomerId: session.customer,
              pendingTierId: null,
              pendingTierAt: null,
              updatedAt: Date.now()
            },
            { merge: true }
          )
          console.log(`Tier opdateret via checkout: ${uid} → ${tierId}`)
        }
        break
      }

      // Abonnement opdateret (skift af plan via Customer Portal)
      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription
        const uid = subscription.metadata?.uid
        if (!uid) break

        // Bug A fix: defensiv init (doc'et findes typisk allerede her, men sikrer
        // mod edge cases hvor portal-event når frem før checkout-event)
        await ensureUserDocInitialized(uid)

        const priceId   = subscription.items.data[0]?.price?.id
        const newTierId = priceId ? getTierIdFromPriceId(priceId) : null
        const periodEnd = getPeriodEnd(subscription)  // ← bruger sikker hjælpefunktion

        if (subscription.cancel_at_period_end) {
          // Brugeren har opsagt — beholder adgang til periodens slutning
          await db.collection('users').doc(uid).set(
            {
              pendingTierId: 'tier_free',
              pendingTierAt: periodEnd,
              subscriptionPeriodEnd: periodEnd,
              updatedAt: Date.now()
            },
            { merge: true }
          )
          console.log(`Opsigelse planlagt for: ${uid} ved ${periodEnd ? new Date(periodEnd).toISOString() : 'ukendt'}`)
        } else if (newTierId) {
          // Plan skiftet (opgradering eller nedgradering med øjeblikkelig effekt)
          await db.collection('users').doc(uid).set(
            {
              tierId: newTierId,
              pendingTierId: null,
              pendingTierAt: null,
              subscriptionPeriodEnd: periodEnd,
              updatedAt: Date.now()
            },
            { merge: true }
          )
          console.log(`Tier opdateret via portal: ${uid} → ${newTierId}`)
        }
        break
      }

      // Månedlig fornyelse — opdater tier og nulstil forbrug
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as Stripe.Invoice
        const sub = invoice.subscription
        if (!sub || typeof sub !== 'string') break

        // ─── V1.4 hotfix (1. juni 2026) — flere ændringer for at fixe ───
        // launch-bug hvor brugere ikke fik counters nulstillet på fornyelse:
        //
        //   1. UID-resolver: subscription.metadata?.uid kan være undefined
        //      hvis abonnementet er blevet modificeret via Customer Portal
        //      (downgrade/upgrade kan miste metadata). Fall back til Firestore-
        //      lookup via stripeCustomerId hvis metadata.uid mangler.
        //
        //   2. Counter-reset komplet: tilføjet voiceNotes + cameraNotes til
        //      reset-listen. Counter-refactor (20. maj 2026) introducerede
        //      brugervendte counters men opdaterede ikke denne handler →
        //      brugere hittede limits permanent uden reset på renewal.
        //
        //   3. storageBytes nulstilles IKKE — den ejes af Cloud Functions
        //      (onStorageUpload/onStorageDelete) og afspejler faktisk
        //      Storage-forbrug, ikke billing-cycle.
        //
        //   4. Try/catch så vi altid logger fejl + returnerer 200 til Stripe
        //      (ellers retrier de webhook'en evigt).
        //
        //   5. Telemetri-event 'usage_reset_on_invoice' for audit + at kunne
        //      bygge synthetic monitor senere.

        try {
          const stripeClient = getStripe()
          const subscription = await stripeClient.subscriptions.retrieve(sub)
          const priceId = subscription.items.data[0]?.price?.id
          const tierId = priceId ? getTierIdFromPriceId(priceId) : subscription.metadata?.tierId
          const periodEnd = getPeriodEnd(subscription)

          // ── UID-resolver: metadata først, derefter customer-id-lookup ──
          let uid: string | undefined = subscription.metadata?.uid

          if (!uid) {
            const customerId = typeof subscription.customer === 'string'
              ? subscription.customer
              : subscription.customer?.id

            if (customerId) {
              const userSnap = await db.collection('users')
                .where('stripeCustomerId', '==', customerId)
                .limit(1)
                .get()
              if (!userSnap.empty) {
                uid = userSnap.docs[0].id
                console.warn(
                  `[invoice.payment_succeeded] uid manglede i metadata, ` +
                  `fundet via stripeCustomerId-lookup: ${uid}`
                )
              }
            }
          }

          if (!uid || !tierId) {
            console.warn(
              `[invoice.payment_succeeded] kan ikke resolve uid/tierId — ` +
              `uid=${uid}, tierId=${tierId}, invoice=${invoice.id}`
            )
            break
          }

          // Bug A fix: hvis det allerførste touch er en fornyelse (sjældent men
          // muligt hvis checkout-eventet droppede), initialisér doc fuldt først.
          await ensureUserDocInitialized(uid)

          const now = Date.now()

          // Opdatér user-doc med tier + period-end
          await db.collection('users').doc(uid).set(
            {
              tierId,
              pendingTierId: null,
              pendingTierAt: null,
              subscriptionPeriodEnd: periodEnd,
              updatedAt: now
            },
            { merge: true }
          )

          // Nulstil ALLE bruger-vendte + interne counters. storageBytes BEVARES.
          await db.collection('users').doc(uid)
            .collection('usage').doc('echolima').set(
              {
                // Brugervendte counters (counter-refactor 20. maj 2026)
                voiceNotes: 0,
                cameraNotes: 0,
                // Legacy/interne counters (bevares for at sikre ingen stale-state
                // i caches eller event-aggregations)
                transcriptions: 0,
                visionCalls: 0,
                aiSummaries: 0,
                resetAt: now
                // storageBytes: BEVARES — ejes af Cloud Functions, ikke billing-cycle
              },
              { merge: true }
            )

          // Telemetri-event til audit + fremtidig synthetic monitor
          try {
            await db.collection('events').add({
              uid,
              appId: 'echolima',
              type: 'usage_reset_on_invoice',
              invoiceId: invoice.id,
              amountPaid: invoice.amount_paid,
              tierId,
              timestamp: now
            })
          } catch (logErr) {
            console.error(
              `[invoice.payment_succeeded] event-log fejlede (reset gennemført alligevel):`,
              logErr
            )
          }

          console.log(
            `[invoice.payment_succeeded] Tier fornyet og forbrug nulstillet: ` +
            `uid=${uid} tier=${tierId} invoice=${invoice.id}`
          )
        } catch (err) {
          console.error(
            `[invoice.payment_succeeded] reset fejlede for invoice=${invoice.id}:`,
            err
          )
          // Vi returnerer alligevel 200 til Stripe (sker via res.json længere nede)
          // ellers retrier de webhook'en evigt → spammer logs uden at hjælpe
        }
        break
      }

      // Abonnement slettet eller betaling fejlet → degradér, men kun hvis
      // customer ikke har andre aktive subscriptions (Bug B fix)
      case 'customer.subscription.deleted':
      case 'invoice.payment_failed': {
        const obj = event.data.object as Stripe.Subscription | Stripe.Invoice
        const subId = 'subscription' in obj
          ? (obj as Stripe.Invoice).subscription
          : (obj as Stripe.Subscription).id
        if (!subId || typeof subId !== 'string') break

        const stripe = getStripe()
        const subscription = await stripe.subscriptions.retrieve(subId)
        const uid = subscription.metadata?.uid
        if (!uid) break

        // Bug A fix: defensiv init før evt. degradering
        await ensureUserDocInitialized(uid)

        // Bug B fix: tjek om customer har andre aktive subs FØR vi degraderer.
        // subscription.customer kan være string, expanded Customer, eller
        // DeletedCustomer — vi henter ID'et defensivt.
        const customerId = typeof subscription.customer === 'string'
          ? subscription.customer
          : subscription.customer?.id

        let resolvedTierId: string = 'tier_free'
        let resolvedPeriodEnd: number | null = null

        if (customerId) {
          const active = await getHighestActiveTier(stripe, customerId, subId)
          if (active) {
            resolvedTierId = active.tierId
            resolvedPeriodEnd = getPeriodEnd(active.subscription)
          }
        }

        await db.collection('users').doc(uid).set(
          {
            tierId: resolvedTierId,
            pendingTierId: null,
            pendingTierAt: null,
            subscriptionPeriodEnd: resolvedPeriodEnd,
            updatedAt: Date.now()
          },
          { merge: true }
        )

        if (resolvedTierId === 'tier_free') {
          console.log(`Tier degraderet til tier_free: ${uid}`)
        } else {
          console.log(`Tier bibeholdt via anden aktiv sub: ${uid} → ${resolvedTierId}`)
        }
        break
      }

      default:
        break
    }
    res.json({ received: true })
  } catch (err) {
    console.error('Stripe webhook behandlingsfejl:', err)
    res.status(500).json({ error: 'Webhook behandling fejlede' })
  }
})

// GET /stripe/portal
router.get('/portal', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const uid = req.user?.uid
    if (!uid) { res.status(401).json({ error: 'unauthenticated', message: 'Ikke autoriseret' }); return }

    const db = getFirestore()
    const userDoc = await db.collection('users').doc(uid).get()
    const stripeCustomerId = userDoc.data()?.stripeCustomerId
    if (!stripeCustomerId) {
      res.status(404).json({
        error: 'no_stripe_customer',
        message: 'Brugeren har ingen Stripe-kunde — start checkout-flow i stedet'
      })
      return
    }
    const stripe = getStripe()
    const returnUrl = process.env.STRIPE_SUCCESS_URL ?? 'https://api.echolima.app/payment/success'
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: returnUrl,
    })
    res.json({ url: portalSession.url })
  } catch (err) {
    console.error('stripe/portal fejl:', err)
    res.status(500).json({ error: 'portal_session_failed', message: 'Kunne ikke oprette portal-session' })
  }
})

// GET /stripe/invoices
router.get('/invoices', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const uid = req.user?.uid
    if (!uid) { res.status(401).json({ error: 'unauthenticated', message: 'Ikke autoriseret' }); return }

    const db = getFirestore()
    const userDoc = await db.collection('users').doc(uid).get()
    const stripeCustomerId = userDoc.data()?.stripeCustomerId
    if (!stripeCustomerId) {
      res.json({ invoices: [] })
      return
    }
    const stripe = getStripe()
    const list = await stripe.invoices.list({ customer: stripeCustomerId, limit: 24 })
    const invoices = list.data
      .filter(inv => inv.status === 'paid' || inv.status === 'open')
      .map(inv => ({
        id: inv.id,
        date: inv.created * 1000,
        amount: inv.amount_paid / 100,
        currency: inv.currency.toUpperCase(),
        status: inv.status,
        pdfUrl: inv.invoice_pdf
      }))
    res.json({ invoices })
  } catch (err) {
    console.error('stripe/invoices fejl:', err)
    res.status(500).json({ error: 'server_error', message: 'Serverfejl' })
  }
})

export default router
