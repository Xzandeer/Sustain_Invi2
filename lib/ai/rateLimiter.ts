// Simple in-memory rate limiter — max N requests per minute per user
interface RateLimitEntry {
  count: number
  windowStart: number
}

const WINDOW_MS = 60_000   // 1 minute window
const MAX_REQUESTS = 10    // max requests per window per user

const store = new Map<string, RateLimitEntry>()

export function checkRateLimit(userId: string): { allowed: boolean; remaining: number } {
  const now = Date.now()
  const entry = store.get(userId)

  if (!entry || now - entry.windowStart > WINDOW_MS) {
    store.set(userId, { count: 1, windowStart: now })
    return { allowed: true, remaining: MAX_REQUESTS - 1 }
  }

  if (entry.count >= MAX_REQUESTS) {
    return { allowed: false, remaining: 0 }
  }

  entry.count++
  return { allowed: true, remaining: MAX_REQUESTS - entry.count }
}

// Clean up old entries every 5 minutes to prevent memory leak
setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of store.entries()) {
    if (now - entry.windowStart > WINDOW_MS * 2) store.delete(key)
  }
}, 300_000)
