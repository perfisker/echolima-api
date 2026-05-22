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
  capabilities?: Capabilities   // Niche-specifikke capabilities (optional — Fase 1: tomme arrays)
}

// ─────────────────────────────────────────────────────────────────────────────
// Niche Capabilities System (Architecture-runde 17. maj 2026)
// Se: EchoLima_Niche_Capabilities_Architecture.md for beslutninger.
//
// Capabilities er klient-metadata til dynamisk adaptation af renderer +
// voice-engine. Prompt forbliver source of truth for AI-analyse-output.
// Capabilities-listen vedligeholdes manuelt i sync med promptens felter.
//
// V1 understøtter tre action-typer:
//   rerun_analysis_with_suffix — backend kører /ai/analyze igen med suffix
//   set_metadata_flag          — Android skriver flag lokalt til Firestore
//   local_ui                   — Android åbner UI-handling (ingen round-trip)
// ─────────────────────────────────────────────────────────────────────────────

type LocalizedText = { da: string; en?: string }
type LocalizedStringArray = { da: string[]; en?: string[] }
type TierId = 'tier_free' | 'tier_basic' | 'tier_pro' | 'tier_unlimited'

// ─── ExtraField — schema-felt som prompten producerer ────────────────────────
export interface ExtraFieldDef {
  id: string                              // 'deltagere', stabilt ID
  displayName: LocalizedText
  type: 'string' | 'string[]' | 'object[]' | 'number' | 'boolean'
  location: 'top_level' | 'summary' | 'metadata'
  minTier?: TierId
  minClientVersion?: string               // semver, optional
}

// ─── VoiceCommand — interaktiv trigger med action ────────────────────────────
export type VoiceActionType =
  | 'rerun_analysis_with_suffix'
  | 'set_metadata_flag'
  | 'local_ui'
// V2-extensions (IKKE implementeret endnu): 'invoke_endpoint' | 'chain'

export interface VoiceCommandDef {
  id: string                              // 'ai_suggestions', stabilt ID
  triggers: LocalizedStringArray
  action: {
    type: VoiceActionType
    params: Record<string, unknown>       // type-afhængigt — valideres pr. type
  }
  description?: LocalizedText             // til "hvad kan jeg sige"-listing
  minTier?: TierId
  minClientVersion?: string
}

// ─── MetadataFlag — semantisk tag på note ────────────────────────────────────
export interface MetadataFlagDef {
  id: string                              // 'pii_detected', stabilt ID
  displayName: LocalizedText
  visualHint?: {
    color?: string                        // hex, fx '#FF6B6B'
    icon?: string                         // ikon-navn, fx 'shield-alert'
  }
  autoDetect?: boolean                    // backend kan auto-tagge
  minTier?: TierId
  minClientVersion?: string
}

// ─── Capabilities-container ──────────────────────────────────────────────────
export interface Capabilities {
  extraFields: ExtraFieldDef[]
  voiceCommands: VoiceCommandDef[]
  metadataFlags: MetadataFlagDef[]
}

// ─── AppDoc — apps/{appId} i Firestore ───────────────────────────────────────
export interface AppDoc {
  id: string
  displayName: LocalizedText
  commonCapabilities?: Capabilities       // app-globale capabilities
}

// Subset returneret af GET /niches (klient-public). Bemærk: prompt-feltet
// EKSKLUDERES bevidst — det er backend-only IP.
export interface NichePublic {
  id: string
  displayName: { da: string; en: string }
  description: { da: string; en: string }
  minTier: string
  order: number
  capabilities?: Capabilities             // niche-specifikke — optional
}

// ─── NichesResponse — GET /niches response-shape ─────────────────────────────
// commonCapabilities: app-globale capabilities fra apps/{appId}
// niches: filtrerede + tier-sorterede niches med niche-specifikke capabilities
// Backward-compat: gamle klienter der kun læser .niches[] fortsætter med at virke.
export interface NichesResponse {
  commonCapabilities?: Capabilities
  niches: NichePublic[]
}
