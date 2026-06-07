// In-memory TTL cache — avoids redundant Firestore reads for repeated questions
interface CacheEntry<T> {
  value: T
  expiresAt: number
}

class TTLCache {
  private store = new Map<string, CacheEntry<unknown>>()
  private readonly ttlMs: number

  constructor(ttlMinutes = 5) {
    this.ttlMs = ttlMinutes * 60 * 1000
  }

  get<T>(key: string): T | null {
    const entry = this.store.get(key)
    if (!entry) return null
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key)
      return null
    }
    return entry.value as T
  }

  set<T>(key: string, value: T): void {
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs })
  }

  invalidate(prefix: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) this.store.delete(key)
    }
  }

  clear(): void {
    this.store.clear()
  }

  size(): number {
    return this.store.size
  }
}

// Singleton — shared across all requests in the same server instance
export const aiCache = new TTLCache(5)
