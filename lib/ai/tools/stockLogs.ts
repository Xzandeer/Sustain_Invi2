// AI assistant tool - stock movement history.
//
// Read-only lookup over the `stockLogs` collection. Blocked for staff accounts
// in app/api/chat/route.ts, since movement history reveals cost and supplier
// patterns the owner may not want shared. Cached via lib/ai/cache.

import { getAdminDb } from '@/lib/firebaseAdmin'

const db = () => getAdminDb()

const toDate = (v: unknown): Date | null => {
  if (!v) return null
  if (typeof v === 'object') {
    const ts = v as { toDate?: () => Date; seconds?: number }
    if (typeof ts.toDate === 'function') return ts.toDate()
    if (typeof ts.seconds === 'number') return new Date(ts.seconds * 1000)
  }
  if (typeof v === 'string' || typeof v === 'number') { const d = new Date(v); return isNaN(d.getTime()) ? null : d }
  return null
}

export async function getStockLogs(): Promise<string> {
  const snap = await db().collection('stockLogs').orderBy('createdAt', 'desc').limit(15).get()

  if (snap.empty) return 'No stock log entries found.'

  const lines = snap.docs.map(d => {
    const data = d.data() as Record<string, unknown>
    const date = toDate(data.createdAt)
    const dateStr = date ? date.toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'N/A'
    const action = typeof data.actionType === 'string' ? data.actionType : 'unknown'
    const item = typeof data.itemName === 'string' ? data.itemName : 'item'
    const user = typeof data.userName === 'string' ? data.userName : 'system'
    const before = data.quantityBefore ?? '?'
    const after = data.quantityAfter ?? '?'
    return `• [${dateStr}] ${action} | ${item} | by ${user} | ${before} → ${after}`
  })

  return `Recent stock activity (last 15):\n${lines.join('\n')}`
}
