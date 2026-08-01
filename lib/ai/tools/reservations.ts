// AI assistant tools - reservation questions.
//
// Read-only lookups: active, pending and overdue reservations.
// Returns formatted strings for the chat answer. Cached via lib/ai/cache.

import { getAdminDb } from '@/lib/firebaseAdmin'
import { aiCache } from '@/lib/ai/cache'

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

const toNum = (v: unknown, fb = 0): number => {
  if (typeof v === 'number' && isFinite(v)) return v
  if (typeof v === 'string') { const p = Number(v); if (isFinite(p)) return p }
  return fb
}

const fmtDate = (d: Date) => d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })

export async function getActiveReservations(): Promise<string> {
  const cacheKey = 'active_reservations'
  const cached = aiCache.get<string>(cacheKey)
  if (cached) return cached

  const snap = await db().collection('reservations').get()
  const now = new Date()
  const all = snap.docs.map(d => ({ id: d.id, ...d.data() } as Record<string, unknown>))
  const active = all.filter(r => {
    const s = String(r.status ?? '').toLowerCase()
    return s === 'active' || s === 'pending' || s === 'reserved'
  })
  const expiringSoon = active.filter(r => {
    const exp = toDate(r.expiresAt)
    return exp && (exp.getTime() - now.getTime()) / 3_600_000 <= 48
  })

  const lines = active.slice(0, 8).map(r => {
    const customer = typeof r.customer === 'string' ? r.customer : 'Unknown'
    const exp = toDate(r.expiresAt)
    const items = Array.isArray(r.items) ? (r.items as Array<Record<string, unknown>>).map(i => `${i.name} x${toNum(i.quantity, 1)}`).join(', ') : 'N/A'
    return `• ${customer}: ${items} — expires ${exp ? fmtDate(exp) : 'N/A'}`
  })

  const result = `Active: ${active.length} | Expiring within 48h: ${expiringSoon.length}\n\n${lines.join('\n') || 'No active reservations.'}`
  aiCache.set(cacheKey, result)
  return result
}

export async function getOverdueReservations(): Promise<string> {
  const snap = await db().collection('reservations').get()
  const now = new Date()
  const overdue = snap.docs
    .map(d => ({ id: d.id, ...d.data() } as Record<string, unknown>))
    .filter(r => {
      const s = String(r.status ?? '').toLowerCase()
      if (s === 'claimed' || s === 'cancelled' || s === 'expired') return false
      const exp = toDate(r.expiresAt)
      return exp && exp < now
    })

  if (overdue.length === 0) return 'No overdue reservations.'

  const lines = overdue.slice(0, 10).map(r => {
    const customer = typeof r.customer === 'string' ? r.customer : 'Unknown'
    const exp = toDate(r.expiresAt)
    const daysOverdue = exp ? Math.floor((now.getTime() - exp.getTime()) / 86400000) : '?'
    return `• ${customer}: ${daysOverdue} day(s) overdue`
  })
  return `${overdue.length} overdue reservation(s):\n${lines.join('\n')}`
}

export async function getPendingReservations(): Promise<string> {
  const snap = await db().collection('reservations').get()
  const pending = snap.docs
    .map(d => ({ id: d.id, ...d.data() } as Record<string, unknown>))
    .filter(r => String(r.status ?? '').toLowerCase() === 'pending')

  if (pending.length === 0) return 'No pending reservations.'

  const lines = pending.slice(0, 8).map(r => {
    const customer = typeof r.customer === 'string' ? r.customer : 'Unknown'
    const items = Array.isArray(r.items) ? (r.items as Array<Record<string, unknown>>).map(i => String(i.name ?? '')).join(', ') : 'N/A'
    return `• ${customer}: ${items}`
  })
  return `${pending.length} pending reservation(s):\n${lines.join('\n')}`
}
