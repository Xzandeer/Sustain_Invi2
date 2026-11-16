// Browser-side memory for Firestore reads that are expensive and change rarely.
//
// The free Firestore plan allows 50,000 document reads a day. Analytics and the
// Dashboard read weeks or months of sales on every visit, though past days
// almost never change - so the same thousands of documents were read again
// each time someone opened the page.
//
// Sales are now read in two parts:
//   - before today: remembered for 30 minutes (kept until the tab reloads);
//   - today:        remembered for 10 seconds, so new sales show at once.
// A sale or refund made in this tab clears both (forgetReads('sales:')).
// Everything is cleared when the user signs out.

import { collection, getDocs, orderBy, query, Timestamp, where, type QueryDocumentSnapshot } from 'firebase/firestore'
import { auth, db } from '@/lib/firebase'

type Entry = { at: number; promise: Promise<unknown> }
const store = new Map<string, Entry>()

/** One answer per key, reused while younger than maxAgeMs; calls arriving together share it. */
export function cachedRead<T>(key: string, maxAgeMs: number, load: () => Promise<T>): Promise<T> {
  const hit = store.get(key)
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.promise as Promise<T>
  const promise = load()
  store.set(key, { at: Date.now(), promise })
  promise.catch(() => {
    if (store.get(key)?.promise === promise) store.delete(key)
  })
  return promise
}

/** Drops remembered reads whose key starts with prefix ('' = all). */
export function forgetReads(prefix = ''): void {
  for (const key of Array.from(store.keys())) if (key.startsWith(prefix)) store.delete(key)
}

// Another user may sign in on this tab: nothing read for the last one is kept.
if (typeof window !== 'undefined') {
  auth.onAuthStateChanged((user) => { if (!user) forgetReads() })
}

const PAST_MAX_AGE_MS = 30 * 60_000
const TODAY_MAX_AGE_MS = 10_000

function salesBetween(fromMs: number, toMs: number, toInclusive: boolean) {
  return getDocs(query(
    collection(db, 'sales'),
    where('createdAt', '>=', Timestamp.fromMillis(fromMs)),
    where('createdAt', toInclusive ? '<=' : '<', Timestamp.fromMillis(toMs)),
    orderBy('createdAt', 'asc'),
  )).then((snap) => snap.docs)
}

/**
 * Sale documents with createdAt in [startMs, endMs], oldest first (or newest
 * first with order 'desc'). Days before today come from memory when possible.
 */
export async function loadSalesBetween(startMs: number, endMs: number, order: 'asc' | 'desc' = 'asc'): Promise<QueryDocumentSnapshot[]> {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const todayMs = today.getTime()

  const parts: Array<Promise<QueryDocumentSnapshot[]>> = []
  if (startMs < todayMs) {
    // The split point is part of the key, so yesterday's answer is not reused after midnight.
    const pastEnd = Math.min(endMs + 1, todayMs)
    parts.push(cachedRead(`sales:past:${startMs}:${pastEnd}`, PAST_MAX_AGE_MS, () => salesBetween(startMs, pastEnd, false)))
  }
  if (endMs >= todayMs) {
    const from = Math.max(startMs, todayMs)
    parts.push(cachedRead(`sales:today:${from}:${endMs}`, TODAY_MAX_AGE_MS, () => salesBetween(from, endMs, true)))
  }
  const docs = (await Promise.all(parts)).flat()
  return order === 'desc' ? [...docs].reverse() : docs
}
