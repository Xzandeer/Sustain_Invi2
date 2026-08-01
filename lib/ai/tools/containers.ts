// AI assistant tools - container / shipment questions.
//
// Read-only lookups over the `containers` collection: all shipments, and the
// active / delivered / pending subsets. Each returns a formatted string that
// goes straight into the chat answer.
//
// Results are cached (lib/ai/cache) to avoid repeated Firestore reads.

import { getAdminDb } from '@/lib/firebaseAdmin'
import { aiCache } from '@/lib/ai/cache'

const db = () => getAdminDb()

const toNum = (v: unknown, fb = 0): number => {
  if (typeof v === 'number' && isFinite(v)) return v
  if (typeof v === 'string') { const p = Number(v); if (isFinite(p)) return p }
  return fb
}
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
const fmt = (n: number) => `₱${n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtDate = (d: Date | null) => d ? d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }) : 'N/A'

// ── Get all shipments/containers ──────────────────────────────────────────────

export async function getAllShipments(): Promise<string> {
  const cacheKey = 'all_shipments'
  const cached = aiCache.get<string>(cacheKey)
  if (cached) return cached

  const snap = await db().collection('containers').get()
  if (snap.empty) return 'No shipment containers found in the system.'

  const containers = snap.docs.map(d => ({ id: d.id, ...d.data() } as Record<string, unknown>))
  const byStatus: Record<string, number> = {}
  containers.forEach(c => {
    const s = String(c.status ?? 'Unknown')
    byStatus[s] = (byStatus[s] ?? 0) + 1
  })

  const statusSummary = Object.entries(byStatus).map(([s, n]) => `${s}: ${n}`).join(' | ')
  const totalCost = containers.reduce((sum, c) => sum + toNum(c.purchaseCost ?? c.cost), 0)

  const lines = containers.slice(0, 10).map(c => {
    const arrival = fmtDate(toDate(c.arrivalDate ?? c.createdAt))
    return `• ${c.name ?? 'Unnamed'} (${c.supplier ?? 'Unknown supplier'}) — ${String(c.status ?? 'Unknown')} | Arrived: ${arrival} | Cost: ${fmt(toNum(c.purchaseCost ?? c.cost))}`
  })

  const result = `Total containers: ${containers.length} (${statusSummary})\nTotal procurement cost: ${fmt(totalCost)}\n\n${lines.join('\n')}`
  aiCache.set(cacheKey, result)
  return result
}

// ── Get active/in-transit shipments ──────────────────────────────────────────

export async function getActiveShipments(): Promise<string> {
  const cacheKey = 'active_shipments'
  const cached = aiCache.get<string>(cacheKey)
  if (cached) return cached

  const snap = await db().collection('containers').get()
  const active = snap.docs
    .map(d => ({ id: d.id, ...d.data() } as Record<string, unknown>))
    .filter(c => {
      const s = String(c.status ?? '').toLowerCase()
      return s === 'active' || s === 'in transit' || s === 'pending'
    })

  if (active.length === 0) {
    return 'No active or in-transit shipments at the moment.'
  }

  const lines = active.map(c => {
    const arrival = fmtDate(toDate(c.arrivalDate ?? c.createdAt))
    return `• ${c.name ?? 'Unnamed'} from ${c.supplier ?? 'Unknown'} — Status: ${c.status} | Cost: ${fmt(toNum(c.purchaseCost ?? c.cost))} | Arrival: ${arrival}`
  })

  const result = `${active.length} active shipment(s):\n${lines.join('\n')}`
  aiCache.set(cacheKey, result)
  return result
}

// ── Get delivered/completed shipments ─────────────────────────────────────────

export async function getDeliveredShipments(): Promise<string> {
  const cacheKey = 'delivered_shipments'
  const cached = aiCache.get<string>(cacheKey)
  if (cached) return cached

  const snap = await db().collection('containers').get()
  const delivered = snap.docs
    .map(d => ({ id: d.id, ...d.data() } as Record<string, unknown>))
    .filter(c => {
      const s = String(c.status ?? '').toLowerCase()
      return s === 'delivered' || s === 'completed' || s === 'closed'
    })
    .sort((a, b) => (toDate(b.arrivalDate ?? b.createdAt)?.getTime() ?? 0) - (toDate(a.arrivalDate ?? a.createdAt)?.getTime() ?? 0))

  if (delivered.length === 0) return 'No completed shipments found.'

  const totalCost = delivered.reduce((sum, c) => sum + toNum(c.purchaseCost ?? c.cost), 0)
  const lines = delivered.slice(0, 10).map(c => {
    const arrival = fmtDate(toDate(c.arrivalDate ?? c.createdAt))
    return `• ${c.name ?? 'Unnamed'} (${c.supplier ?? 'Unknown'}) — ${fmt(toNum(c.purchaseCost ?? c.cost))} | Arrived: ${arrival}`
  })

  const result = `${delivered.length} completed shipment(s) | Total cost: ${fmt(totalCost)}\n${lines.join('\n')}`
  aiCache.set(cacheKey, result)
  return result
}

// ── Get pending shipments ─────────────────────────────────────────────────────

export async function getPendingShipments(): Promise<string> {
  const cacheKey = 'pending_shipments'
  const cached = aiCache.get<string>(cacheKey)
  if (cached) return cached

  const snap = await db().collection('containers').get()
  const pending = snap.docs
    .map(d => ({ id: d.id, ...d.data() } as Record<string, unknown>))
    .filter(c => String(c.status ?? '').toLowerCase() === 'pending')

  if (pending.length === 0) return 'No pending shipments at the moment.'

  const lines = pending.map(c =>
    `• ${c.name ?? 'Unnamed'} from ${c.supplier ?? 'Unknown'} — Cost: ${fmt(toNum(c.purchaseCost ?? c.cost))}`
  )

  const result = `${pending.length} pending shipment(s):\n${lines.join('\n')}`
  aiCache.set(cacheKey, result)
  return result
}
