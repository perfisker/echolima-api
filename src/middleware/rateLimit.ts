import rateLimit from 'express-rate-limit'

// Generel rate limit: 100 requests per 15 min per IP
export const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'For mange requests. Prøv igen om lidt.' }
})

// Strammere limit på auth-endpoints
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'For mange login-forsøg. Prøv igen om lidt.' }
})
