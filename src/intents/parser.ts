import { getFirestore } from 'firebase-admin/firestore'
import { IntentDef, SlotDef } from '../types'

// ─────────────────────────────────────────────────────────────────────────────
// Voice Intents — Parser-helpers
//
// loadIntentDef:   Henter intent-def fra apps/{appId}.commonCapabilities.intents
//                  med 5 min in-memory cache (samme mønster som niche-cache i ai.ts).
// buildNluPrompt:  Konstruerer GPT-4o-mini prompt med slot-defs + kontakt-context.
// validateSlots:   Type- og regex-validerer raw NLU-output mod slot-defs.
//
// Architecture-doc: §2 Beslutninger 5-8.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Intent-cache (in-memory, 5 min TTL) ───
// Cacher HELE intents[]-arrayet på app-niveau (ikke pr. intentId) fordi vi typisk
// henter dem ud sammen ved capability-listing alligevel. Reduces Firestore-reads
// drastisk ved spike (fx Android-startup hvor mange klienter samtidigt fetcher).
interface CachedIntents {
  intents: IntentDef[]
  fetchedAt: number
}

let intentCache: CachedIntents | null = null
const INTENT_CACHE_TTL_MS = 5 * 60 * 1000

export function clearIntentCache(): void {
  intentCache = null
}

export async function loadIntentDef(intentId: string): Promise<IntentDef | null> {
  const now = Date.now()
  if (!intentCache || now - intentCache.fetchedAt > INTENT_CACHE_TTL_MS) {
    const db = getFirestore()
    const appSnap = await db.collection('apps').doc('echolima').get()
    const intents: IntentDef[] = appSnap.data()?.commonCapabilities?.intents ?? []
    intentCache = { intents, fetchedAt: now }
  }
  return intentCache.intents.find(i => i.id === intentId) ?? null
}

// ─── NLU-prompt builder ───
// Bygger en struktureret prompt til GPT-4o-mini der ekstraherer slots fra
// brugerens tale. Inkluderer:
//   - Intent-id og slot-defs (så modellen ved hvilke felter at fylde ud)
//   - Brugerens kontaktbog (til contact_ref-resolution)
//   - Note-kontekst (tasks + summary, til content_ref-semantik senere)
//   - Few-shot eksempler (concrete create_contact-cases)
//
// Output-format: rene JSON med slot-IDs som nøgler. Null for manglende slots.
export function buildNluPrompt(
  intent: IntentDef,
  transcript: string,
  contacts: Array<{ name: string; email?: string }>,
  noteContext?: { tasks?: string[]; summary?: string }
): string {
  const contactNames = contacts.map(c => c.name).join(', ')
  const tasksList = noteContext?.tasks?.map((t, i) => `${i + 1}. ${t}`).join('\n') ?? '(ingen)'

  return `Du parser dansk tale til strukturerede intent-slots.

Intent: ${intent.id}
Beskrivelse: ${intent.description?.da ?? ''}

Slot-definitioner:
${intent.slots.map(s => `- ${s.id} (type: ${s.type}, required: ${s.required}): ${s.description?.da ?? ''}`).join('\n')}

Tilgængelige kontakter: ${contactNames || '(ingen)'}

Note-kontekst:
- Resumé: ${noteContext?.summary ?? '(ingen)'}
- Opgaver:
${tasksList}

Bruger sagde: "${transcript}"

Returnér KUN JSON med slot-IDs som nøgler. Brug null hvis et required slot ikke kan extracteres.

Regler:
- contact_ref: returnér kontaktens navn (ikke email) — null hvis ingen match
- boolean: true eller false
- email: kun valid email-format — ellers null
- phone: kun cifre, mellemrum, + og bindestreger tilladt — ellers null

Eksempel 1 (create_contact, "opret kontakt Anders anders@firma.dk tlf 12345678"):
{ "name": "Anders", "email": "anders@firma.dk", "phone": "12345678" }

Eksempel 2 (create_contact, "ny kontakt Maria"):
{ "name": "Maria", "email": null, "phone": null }`
}

// ─── Slot-validering ───
// Type-check + regex-validering af raw NLU-output mod slot-defs.
// Returnerer et nyt objekt med KUN gyldigt udfyldte slots — ugyldige droppes
// stille (slot betragtes som "ikke extracteret").
//
// missingRequired skal beregnes UDENFOR denne funktion (se /intents/parse-handler)
// så caller kan bygge ASK-flow på baggrund af resultatet.
export function validateSlots(
  slotDefs: SlotDef[],
  rawSlots: Record<string, unknown>
): Record<string, unknown> {
  const validated: Record<string, unknown> = {}

  for (const slot of slotDefs) {
    const value = rawSlots[slot.id]
    if (value == null) continue

    switch (slot.type) {
      case 'email':
        if (typeof value === 'string' && /^[\w._%+-]+@[\w.-]+\.[A-Za-z]{2,}$/.test(value)) {
          validated[slot.id] = value
        }
        break
      case 'phone':
        if (typeof value === 'string' && /^[\d\s+()-]{6,20}$/.test(value)) {
          validated[slot.id] = value
        }
        break
      case 'string':
      case 'contact_ref':
      case 'group_ref':
      case 'recipient_ref':
        if (typeof value === 'string' && value.trim()) validated[slot.id] = value.trim()
        break
      case 'boolean':
        validated[slot.id] = Boolean(value)
        break
      case 'number':
        if (typeof value === 'number') validated[slot.id] = value
        break
      case 'content_ref':
        validated[slot.id] = value  // boolean, "all", "none" eller number[]
        break
    }

    // Generic regex-validering hvis specificeret i slot-def
    if (slot.validation?.pattern && typeof validated[slot.id] === 'string') {
      if (!new RegExp(slot.validation.pattern).test(validated[slot.id] as string)) {
        delete validated[slot.id]
      }
    }
  }

  return validated
}
