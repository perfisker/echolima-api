import { Router, Request, Response } from 'express'
import Stripe from 'stripe'
import { getFirestore } from 'firebase-admin/firestore'
import { verifyToken } from '../middleware/auth'
import { AuthRequest } from '../types'

const router = Router()

function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) throw new Error('STRIPE_SECRET_KEY er ikke sat')
  return new Stripe(key)
}

// Mapning fra tierId → Stripe Price ID
function getPriceId(tierId: string): string {
  const map: Record<string, string | undefined> = {
    charlie: process.env.STRIPE_PRICE_CHARLIE,
    papa:    process.env.STRIPE_PRICE_PAPA,
  }
  const priceId = map[tierId]
  if (!priceId) throw new Error(`Ingen Stripe price ID for tier: ${tierId}`)
  return priceId
}

// Mapning fra Stripe Price ID → tierId (omvendt opslag)
function getTierIdFromPriceId(priceId: string): string | null {
  const map: Record<string, string> = {}
  if (process.env.STRIPE_PRICE_CHARLIE) map[process.env.STRIPE_PRICE_CHARLIE] = 'charlie'
  if (process.env.STRIPE_PRICE_PAPA)    map[process.env.STRIPE_PRICE_PAPA]    = 'papa'
  return map[priceId] ?? null
}

// POST /stripe/create-checkout-session
router.post('/create-checkout-session', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const { tierId } = req.body
    if (!tierId || typeof tierId !== 'string') {
      res.status(400).json({ error: 'Mangler tierId' })
      return
    }

    const stripe = getStripe()
    const priceId = getPriceId(tierId)
    const uid = req.user?.uid
    if (!uid) { res.status(401).json({ error: 'Ikke autoriseret' }); return }

    const successUrl = process.env.STRIPE_SUCCESS_URL ?? 'https://api.echolima.app/payment/success'
    const cancelUrl  = process.env.STRIPE_CANCEL_URL  ?? 'https://api.echolima.app/payment/cancel'

    // Hent evt. eksisterende Stripe kunde-ID så vi genbruger kunden
    const db = getFirestore()
    const userDoc = await db.collection('users').doc(uid).get()
    const existingCustomerId = userDoc.data()?.stripeCustomerId

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
    res.status(500).json({ error: 'Kunne ikke oprette betalingssession' })
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
        const uid    = subscription.metadata?.uid
        if (!uid) break

        const priceId  = subscription.items.data[0]?.price?.id
        const newTierId = priceId ? getTierIdFromPriceId(priceId) : null
        const periodEnd = subscription.current_period_end * 1000 // ms

        if (subscription.cancel_at_period_end) {
          // Brugeren har opsagt — beholder adgang til periodens slutning
          await db.collection('users').doc(uid).set(
            {
              pendingTierId: 'foxtrot',
              pendingTierAt: periodEnd,
              subscriptionPeriodEnd: periodEnd,
              updatedAt: Date.now()
            },
            { merge: true }
          )
          console.log(`Opsigelse planlagt for: ${uid} ved ${new Date(periodEnd).toISOString()}`)
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
        // Ignorer fakturaer der ikke er tilknyttet et abonnement (f.eks. engangsbetalinger)
        if (!sub || typeof sub !== 'string') break

        const stripe = getStripe()
        const subscription = await stripe.subscriptions.retrieve(sub)
        const uid     = subscription.metadata?.uid
        const priceId = subscription.items.data[0]?.price?.id
        const tierId  = priceId ? getTierIdFromPriceId(priceId) : subscription.metadata?.tierId

        if (uid && tierId) {
          const periodEnd = subscription.current_period_end * 1000
          const now = Date.now()

          // Opdater brugerens tier og periode
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

          // Nulstil forbrug for den nye periode
          await db.collection('users').doc(uid)
            .collection('usage').doc('echolima').set(
              {
                transcriptions: 0,
                visionCalls: 0,
                aiSummaries: 0,
                resetAt: now
              },
              { merge: true }
            )

          console.log(`Tier fornyet og forbrug nulstillet: ${uid} → ${tierId}`)
        }
        break
      }

      // Abonnement slettet eller betaling fejlet → tilbage til foxtrot
      case 'customer.subscription.deleted':
      case 'invoice.payment_failed': {
        const obj = event.data.object as Stripe.Subscription | Stripe.Invoice
        const subId = 'subscription' in obj
          ? (obj as Stripe.Invoice).subscription
          : (obj as Stripe.Subscription).id

        if (subId && typeof subId === 'string') {
          const stripe = getStripe()
          const subscription = await stripe.subscriptions.retrieve(subId)
          const uid = subscription.metadata?.uid
          if (uid) {
            await db.collection('users').doc(uid).set(
              {
                tierId: 'foxtrot',
                pendingTierId: null,
                pendingTierAt: null,
                updatedAt: Date.now()
              },
              { merge: true }
            )
            console.log(`Tier nulstillet til foxtrot: ${uid}`)
          }
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
// Åbner Stripe Customer Portal — brugeren kan skifte plan, opsige, se fakturaer
router.get('/portal', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const uid = req.user?.uid
    if (!uid) { res.status(401).json({ error: 'Ikke autoriseret' }); return }

    const db = getFirestore()
    const userDoc = await db.collection('users').doc(uid).get()
    const stripeCustomerId = userDoc.data()?.stripeCustomerId

    if (!stripeCustomerId) {
      res.status(404).json({ error: 'Ingen Stripe-kunde fundet' })
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
    res.status(500).json({ error: 'Kunne ikke oprette portal-session' })
  }
})

// GET /stripe/invoices — hent betalingshistorik (kræver auth)
router.get('/invoices', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const uid = req.user?.uid
    if (!uid) { res.status(401).json({ error: 'Ikke autoriseret' }); return }

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
    res.status(500).json({ error: 'Serverfejl' })
  }
})

export default router
