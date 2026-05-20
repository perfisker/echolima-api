import { Request } from 'express'
import { DecodedIdToken } from 'firebase-admin/auth'

export interface AuthRequest extends Request {
  user?: DecodedIdToken
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier-grænser og forbrug (counter-refactor 20. maj 2026)
//
// Counter-modellen er forenklet fra tre tællere (transcriptions/aiSummaries/
// visionCalls) til to bruger-vendte counters:
//
//   voiceNotes  = noter UDEN billeder (voice-only)
//   cameraNotes = noter MED billeder (camera+voice)
//
// Plus storageBytes for fil-størrelse. Internt logger backend stadig hver
// OpenAI-kald som separat event i events-collection for cost-analyse, men
// dem ser brugeren ikke. Tier-grænser og /tiers/check arbejder kun mod de to
// counters ovenfor.
//
// -1 betyder ubegrænset.
// ─────────────────────────────────────────────────────────────────────────────

export interface TierLimits {
  voiceNotesPerMonth: number   // -1 = ubegrænset
  cameraNotesPerMonth: number
  storageMB: number
}

export interface Tier {
  id: string
  displayName: { da: string; en: string }
  description: { da: string; en: string }
  price: number
  currency: string
  voiceNotesPerMonth: number
  cameraNotesPerMonth: number
  storageMB: number
  active: boolean
  order: number
}

export interface UsageRecord {
  voiceNotes: number       // antal voice-only noter denne periode
  cameraNotes: number      // antal camera+voice noter denne periode
  storageBytes: number     // samlet størrelse af filer i Firebase Storage
  resetAt: number          // timestamp for sidste månedlige nulstilling
}

// User-facing action type for POST /usage/record
// Backend mapper internt til counter-felter på UsageRecord
export type UsageAction = 'voiceNote' | 'cameraNote'

// ─────────────────────────────────────────────────────────────────────────────
// Niches (AI-pipeline MOAT)
//
// Niche-docs lever i Firestore (niches/{nicheId}) og giver os mulighed for at
// forbedre prompts uden deploy. Hver niche er tilknyttet ét eller flere apps
// via appIds-arrayet (1-til-mange relation).
// ─────────────────────────────────────────────────────────────────────────────

export interface NicheDoc {
  id: string
  displayName: { da: string; en: string }
  description: { da: string; en: string }
  prompt: string                // Med {{transcription}} placeholder
  minTier: string               // 'tier_free' | 'tier_basic' | 'tier_pro' | 'tier_unlimited'
  appIds: string[]              // Hvilke apps niche er tilgængelig i, fx ['echolima']
  isActive: boolean
  order: number
  version: string               // Til sporbarhed af prompt-iterationer
  createdAt: number             // Date.now() — matcher seedNiches og seedTiers
  updatedAt: number
}

// Subset returneret af GET /niches (klient-public). Bemærk: prompt-feltet
// EKSKLUDERES bevidst — det er backend-only IP.
export interface NichePublic {
  id: string
  displayName: { da: string; en: string }
  description: { da: string; en: string }
  minTier: string
  order: number
}
