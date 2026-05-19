import { Request } from 'express'
import { DecodedIdToken } from 'firebase-admin/auth'

export interface AuthRequest extends Request {
  user?: DecodedIdToken
}

export interface TierLimits {
  transcriptions: number   // per måned, -1 = ubegrænset
  visionCalls: number
  aiSummaries: number
  storageGB: number
  maxNoteDurationSeconds: number
}

export interface Tier {
  id: string
  name: string
  appId: string
  priceMonthly: number
  limits: TierLimits
  features: string[]
}

export interface UsageRecord {
  transcriptions: number
  visionCalls: number
  aiSummaries: number
  storageBytes: number
  resetAt: number
}

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
