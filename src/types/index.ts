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
