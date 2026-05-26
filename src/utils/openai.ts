import OpenAI from 'openai'

/**
 * Lazy OpenAI client factory.
 *
 * Kaster fejl hvis OPENAI_API_KEY env-var ikke er sat — så server fejler tidligt
 * i stedet for at returnere kryptiske API-fejl ved første kald.
 *
 * Tidligere lokal funktion i ai.ts. Flyttet hertil 26. maj 2026 da intents.ts
 * også skal bruge den (Voice Intents V1.1-rollout).
 */
export function getOpenAI(): OpenAI {
  const key = process.env.OPENAI_API_KEY
  if (!key) throw new Error('OPENAI_API_KEY er ikke sat')
  return new OpenAI({ apiKey: key })
}

/**
 * Retry-logik til OpenAI rate limits.
 *
 * Ved 429 (rate limit) venter vi eksponentielt og prøver igen.
 * Andre fejl kastes videre med det samme — ingen grund til at prøve igen.
 * Forsøg: 0 → vent 1s → forsøg 1 → vent 2s → forsøg 2 → vent 4s → kast fejl
 *
 * Tidligere lokal funktion i ai.ts. Flyttet hertil 26. maj 2026 sammen med
 * getOpenAI() så multiple routes (ai.ts, intents.ts, ++) kan dele samme logik.
 */
export async function callWithRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3
): Promise<T> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn()
    } catch (err: any) {
      const isRateLimit =
        err?.status === 429 ||
        err?.message?.toLowerCase().includes('rate limit') ||
        err?.message?.toLowerCase().includes('too many requests')

      // Kast fejlen videre hvis det ikke er rate limit, eller vi har brugt alle forsøg
      if (!isRateLimit || attempt === maxRetries - 1) throw err

      const delayMs = Math.pow(2, attempt) * 1000  // 1s, 2s, 4s
      console.warn(`OpenAI rate limit — venter ${delayMs}ms (forsøg ${attempt + 1}/${maxRetries})`)
      await new Promise(resolve => setTimeout(resolve, delayMs))
    }
  }
  throw new Error('Max retries exceeded')
}
