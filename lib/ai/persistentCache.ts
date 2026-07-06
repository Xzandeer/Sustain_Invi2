// Persistent AI response cache backed by Firestore.
// On API quota exhaustion, the chatbot serves the last known-good answer.

import { getAdminDb } from '@/lib/firebaseAdmin'

const CACHE_COLLECTION = 'ai_response_cache'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

interface CacheEntry {
  reply: string
  usedTools: string[]
  savedAt: number
  questionPattern: string
}

// Normalise a question into a stable cache key
export function getCacheKey(message: string): string {
  return message
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 80)
}

export async function saveToPersistentCache(
  key: string,
  reply: string,
  usedTools: string[],
  originalMessage: string
): Promise<void> {
  try {
    const db = getAdminDb()
    const entry: CacheEntry = {
      reply,
      usedTools,
      savedAt: Date.now(),
      questionPattern: originalMessage.slice(0, 120),
    }
    await db.collection(CACHE_COLLECTION).doc(key).set(entry)
  } catch {
    // Non-critical — never let cache writes break the main flow
  }
}

export async function getFromPersistentCache(
  key: string
): Promise<{ reply: string; usedTools: string[]; age: number } | null> {
  try {
    const db = getAdminDb()
    const doc = await db.collection(CACHE_COLLECTION).doc(key).get()
    if (!doc.exists) return null

    const data = doc.data() as CacheEntry
    const age = Date.now() - data.savedAt
    if (age > CACHE_TTL_MS) return null

    return { reply: data.reply, usedTools: data.usedTools, age }
  } catch {
    return null
  }
}

export function formatCacheAge(ms: number): string {
  const minutes = Math.floor(ms / 60000)
  const hours = Math.floor(ms / 3600000)
  if (hours >= 1) return `${hours}h ago`
  if (minutes >= 1) return `${minutes}m ago`
  return 'just now'
}
