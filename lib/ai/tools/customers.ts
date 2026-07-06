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
const getSaleDate = (s: Record<string, unknown>) => toDate(s.createdAt ?? s.date ?? s.saleDate)
const getSaleAmount = (s: Record<string, unknown>) => toNum(s.totalAmount ?? s.amount ?? s.total)

// ── Get all customers (derived from sales + reservations) ─────────────────────

export async function getAllCustomers(): Promise<string> {
  const cacheKey = 'all_customers'
  const cached = aiCache.get<string>(cacheKey)
  if (cached) return cached

  const [salesSnap, resSnap] = await Promise.all([
    db().collection('sales').get(),
    db().collection('reservations').get(),
  ])

  const map: Record<string, { name: string; email: string; contact: string; spent: number; orders: number; reservations: number; lastSeen: Date | null }> = {}

  salesSnap.docs.forEach(d => {
    const data = d.data() as Record<string, unknown>
    const name = String(data.customer ?? data.customerName ?? '').trim()
    const email = String(data.customerEmail ?? '').trim().toLowerCase()
    const contact = String(data.customerContactNumber ?? '').trim()
    if (!name || name.toLowerCase() === 'walk-in') return
    const key = email || name.toLowerCase()
    if (!map[key]) map[key] = { name, email, contact, spent: 0, orders: 0, reservations: 0, lastSeen: null }
    map[key].spent += getSaleAmount(data)
    map[key].orders++
    const d2 = getSaleDate(data)
    if (d2 && (!map[key].lastSeen || d2 > map[key].lastSeen!)) map[key].lastSeen = d2
  })

  resSnap.docs.forEach(d => {
    const data = d.data() as Record<string, unknown>
    const name = String(data.customer ?? data.customerName ?? '').trim()
    const email = String(data.customerEmail ?? '').trim().toLowerCase()
    if (!name) return
    const key = email || name.toLowerCase()
    if (!map[key]) map[key] = { name, email, contact: '', spent: 0, orders: 0, reservations: 0, lastSeen: null }
    map[key].reservations++
  })

  const sorted = Object.values(map).sort((a, b) => b.spent - a.spent)
  if (sorted.length === 0) {
    return 'No customers found. Customers are automatically registered from sales and reservation records.'
  }

  const lines = sorted.slice(0, 15).map((c, i) =>
    `${i + 1}. ${c.name}${c.email ? ` (${c.email})` : ''}: ${c.orders} order(s), ${fmt(c.spent)} total spent, ${c.reservations} reservation(s)`
  )

  const result = `${sorted.length} customer(s) total:\n${lines.join('\n')}`
  aiCache.set(cacheKey, result)
  return result
}

// ── Get a specific customer's purchase history ────────────────────────────────

export async function getCustomerHistory(name: string): Promise<string> {
  if (!name || name.trim().length < 2) return 'Please provide a customer name to look up.'
  const q = name.trim().toLowerCase()

  const [salesSnap, resSnap] = await Promise.all([
    db().collection('sales').get(),
    db().collection('reservations').get(),
  ])

  const sales = salesSnap.docs
    .map(d => ({ id: d.id, ...d.data() } as Record<string, unknown>))
    .filter(d => {
      const n = String(d.customer ?? d.customerName ?? '').toLowerCase()
      const e = String(d.customerEmail ?? '').toLowerCase()
      return n.includes(q) || e.includes(q)
    })
    .sort((a, b) => (getSaleDate(b)?.getTime() ?? 0) - (getSaleDate(a)?.getTime() ?? 0))

  const reservations = resSnap.docs
    .map(d => ({ id: d.id, ...d.data() } as Record<string, unknown>))
    .filter(d => {
      const n = String(d.customer ?? d.customerName ?? '').toLowerCase()
      const e = String(d.customerEmail ?? '').toLowerCase()
      return n.includes(q) || e.includes(q)
    })
    .sort((a, b) => (toDate(b.createdAt)?.getTime() ?? 0) - (toDate(a.createdAt)?.getTime() ?? 0))

  if (sales.length === 0 && reservations.length === 0) {
    return `No records found for customer matching "${name}".`
  }

  const customerName = sales[0] ? String(sales[0].customer ?? sales[0].customerName ?? name) : name
  const totalSpent = sales.reduce((s, x) => s + getSaleAmount(x), 0)

  const saleLines = sales.slice(0, 10).map(s => {
    const date = getSaleDate(s)?.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }) ?? 'N/A'
    const items = Array.isArray(s.items)
      ? (s.items as Array<Record<string, unknown>>).map(i => {
          const name = String(i.name ?? '').trim()
          const price = toNum(i.price)
          const qty = toNum(i.quantity, 1)
          return `${name} x${qty} @ ${fmt(price)} each (${fmt(price * qty)})`
        }).join('; ')
      : ''
    return `  • ${date}: Total ${fmt(getSaleAmount(s))}${items ? `\n    Items: ${items}` : ''}`
  })

  const resLines = reservations.slice(0, 5).map(r => {
    const date = toDate(r.createdAt)?.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }) ?? 'N/A'
    return `  • ${date}: ${String(r.status ?? 'Unknown')} reservation`
  })

  const lines = [
    `Customer: ${customerName}`,
    `Total purchases: ${sales.length} order(s), ${fmt(totalSpent)} total spent`,
  ]
  if (saleLines.length > 0) lines.push(`\nSales history:\n${saleLines.join('\n')}`)
  if (resLines.length > 0) lines.push(`\nReservations:\n${resLines.join('\n')}`)

  return lines.join('\n')
}
