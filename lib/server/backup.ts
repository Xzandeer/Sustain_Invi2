// Backup format shared by the export route and the restore script.
//
// Firestore Timestamps do not survive JSON.stringify - they become plain
// objects of seconds and nanoseconds, and a restore would write them back as
// maps rather than dates, breaking every date range query in the system. Each
// one is therefore written as a tagged value and turned back into a Timestamp
// on restore.

export const BACKUP_FORMAT_VERSION = 1

// Every collection that holds store data. ai_forecast_cache is left out
// deliberately: it is derived from sales and rebuilt on demand, so restoring
// an old copy would only show a stale forecast.
export const BACKUP_COLLECTIONS = [
  'inventory',
  'categories',
  'sales',
  'receipts',
  'reservations',
  'stockLogs',
  'users',
  'storeSettings',
  'transactionCounters',
] as const

export interface BackupFile {
  format: 'sustain-backup'
  version: number
  exportedAt: string
  exportedBy: string
  counts: Record<string, number>
  collections: Record<string, Record<string, unknown>>
}

const TS_TAG = '__timestamp'

interface TimestampLike {
  toDate: () => Date
}

const isTimestamp = (value: unknown): value is TimestampLike =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { toDate?: unknown }).toDate === 'function'

/** Firestore value -> JSON-safe value, tagging Timestamps. */
export function serializeValue(value: unknown): unknown {
  if (isTimestamp(value)) {
    return { [TS_TAG]: value.toDate().toISOString() }
  }
  if (Array.isArray(value)) return value.map(serializeValue)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = serializeValue(v)
    return out
  }
  return value
}

/** JSON value -> Firestore value. `makeTimestamp` is passed in so this file
 *  does not depend on the Admin SDK and stays usable from a plain script. */
export function deserializeValue(value: unknown, makeTimestamp: (d: Date) => unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => deserializeValue(v, makeTimestamp))
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj)
    if (keys.length === 1 && keys[0] === TS_TAG && typeof obj[TS_TAG] === 'string') {
      return makeTimestamp(new Date(obj[TS_TAG] as string))
    }
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) out[k] = deserializeValue(v, makeTimestamp)
    return out
  }
  return value
}
