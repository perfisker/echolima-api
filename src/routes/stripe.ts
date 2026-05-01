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

// Mapning fra tierId → Stripe Price ID (sættes som env vars i Render)
function getPriceId(tierId: string): string {
  const map: Record<string, string | undefined> = {
    charlie: process.env.STRIPE_PRICE_CHARLIE,
    papa:    process.env.STRIPE_PRICE_PAPA,
  }
  const priceId = map[tierId]
  if (!priceId) throw new Error(`Ingen Stripe price ID for tier: ${tierId}`)
  return priceId
}

// POST /stripe/create-checkout-session
// Body: { tierId: 'charlie' | 'papa' }
// Kræver auth — returnerer { url } til Stripe Checkout
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
    const successUrl = process.env.STRIPE_SUCCESS_URL ?? 'https://echolima.app/payment/success'
    const cancelUrl  = process.env.STRIPE_CANCEL_URL  ?? 'https://echolima.app/payment/cancel'

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
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
// Stripe sender events hertil — verificer signatur og opdater tier
// VIGTIGT: raw body kræves til signaturverifikation (se index.ts)
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

      // Ny abonnement oprettet / betaling gennemført
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session
        const uid    = session.metadata?.uid
        const tierId = session.metadata?.tierId
        if (uid && tierId) {
          await db.collection('users').doc(uid).set(
            { tierId, stripeCustomerId: session.customer, updatedAt: Date.now() },
            { merge: true }
          )
          console.log(`Tier opdateret: ${uid} → ${tierId}`)
        }
        break
      }

      // Abonnement fornyet (månedlig betaling)
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as Stripe.Invoice
        const sub = invoice.subscription
        if (sub && typeof sub === 'string') {
          const stripe = getStripe()
          const subscription = await stripe.subscriptions.retrieve(sub)
          const uid    = subscription.metadata?.uid
          const tierId = subscription.metadata?.tierId
          if (uid && tierId) {
            await db.collection('users').doc(uid).set(
              { tierId, updatedAt: Date.now() },
              { merge: true }
            )
          }
        }
        break
      }

      // Abonnement annulleret / betaling fejlet
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
              { tierId: 'foxtrot', updatedAt: Date.now() },
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
// Returnerer URL til Stripe Customer Portal (bruger kan opsige/ændre abonnement)
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
    const returnUrl = process.env.STRIPE_SUCCESS_URL ?? 'https://echolima.app'
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

export default router
