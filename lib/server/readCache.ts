// Server-side memory for expensive Firestore reads.
//
// The free Firestore plan allows 50,000 document reads a day. A handful of
// lookups read whole collections (every piece on the shelf, weeks of sales),
// so repeating them on every page load used the day's allowance in minutes.
//
// remember(key, maxAgeMs, load, version?) keeps one answer per key:
//   - reused while it is younger than maxAgeMs AND its version matches;
//   - two requests arriving together share one read;
//   - a failed read is not kept.
// The version is a cheap fingerprint of what the answer depends on (for the
// shelf: each item's stock, holds and last update), so a change made anywhere,
// even by another server instance, is picked up on the next request.
//
// forget(prefix) drops answers at once after a write in this process.

type Entry = { at: number; version: string; promise: Promise<unknown> }

const globalStore = globalThis as unknown as { __sustainReadCache?: Map<string, Entry> }
const store: Map<string, Entry> = (globalStore.__sustainReadCache ??= new Map())

export function remember<T>(key: string, maxAgeMs: number, load: () => Promise<T>, version = ''): Promise<T> {
  const hit = store.get(key)
  if (hit && hit.version === version && Date.now() - hit.at < maxAgeMs) return hit.promise as Promise<T>

  const promise = load()
  store.set(key, { at: Date.now(), version, promise })
  promise.catch(() => {
    if (store.get(key)?.promise === promise) store.delete(key)
  })
  return promise
}

/** Drops every remembered answer whose key starts with prefix ('' = all). */
export function forget(prefix = ''): void {
  for (const key of Array.from(store.keys())) if (key.startsWith(prefix)) store.delete(key)
}

/** An order-independent fingerprint of a list of strings (kept whole: a few KB, no collisions). */
export function fingerprint(parts: string[]): string {
  return [...parts].sort().join('|')
}
