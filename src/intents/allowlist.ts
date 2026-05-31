// ─────────────────────────────────────────────────────────────────────────────
// Voice Intents — Endpoint Allowlist (Architecture Beslutning #9)
//
// STRIKT allowlist over endpoints der må invokeres via 'invoke_endpoint'-action.
// Tilføjelse af nye endpoints kræver kodeændring + code review.
//
// Sikkerheds-rationale:
//   Et kompromitteret Firestore-state (fx hvis admin-credentials lækker) må
//   ALDRIG kunne pege et intent's action.endpoint mod arbitrære routes som
//   /stripe/webhook, /admin/* eller /usage/reset. Allowlist'en lever i koden
//   så den kun kan ændres via deploy — ikke via Firestore-update.
//
// Tilføj nye intents nedenfor med tuples af (endpoint, method, intentId).
// IntentId-kravet sikrer at en intent ikke kan "smug-route" til et endpoint
// der oprindeligt var allowlistet for en ANDEN intent.
// ─────────────────────────────────────────────────────────────────────────────

export const INTENT_ENDPOINT_ALLOWLIST = [
  { endpoint: '/contacts',           method: 'POST', intentId: 'create_contact' },
  { endpoint: '/tags',               method: 'POST', intentId: 'create_tag' },
  { endpoint: '/email/send',         method: 'POST', intentId: 'send_email' },     // V1.4 — endpoint flyttet 1. juni 2026
  { endpoint: '/email/compose-send', method: 'POST', intentId: 'send_email' },     // V1.3 — DEPRECATED, slettes når App-WS fuldt migreret
  // V1.5: { endpoint: '/groups',             method: 'POST', intentId: 'create_group' },
] as const

export function isAllowedEndpoint(endpoint: string, method: string, intentId: string): boolean {
  return INTENT_ENDPOINT_ALLOWLIST.some(
    a => a.endpoint === endpoint && a.method === method && a.intentId === intentId
  )
}
