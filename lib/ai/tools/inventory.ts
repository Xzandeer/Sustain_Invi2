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
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v
  if (typeof v === 'object') {
    const ts = v as { toDate?: () => Date; seconds?: number }
    if (typeof ts.toDate === 'function') { const d = ts.toDate(); return isNaN(d.getTime()) ? null : d }
    if (typeof ts.seconds === 'number') return new Date(ts.seconds * 1000)
  }
  if (typeof v === 'string' || typeof v === 'number') { const d = new Date(v); return isNaN(d.getTime()) ? null : d }
  return null
}
const fmt = (n: number) => `₱${n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export async function getLowStockItems(): Promise<string> {
  const cacheKey = 'low_stock'
  const cached = aiCache.get<string>(cacheKey)
  if (cached) return cached

  const snap = await db().collection('inventory').get()
  const items = snap.docs
    .map(d => ({ id: d.id, ...d.data() } as Record<string, unknown>))
    .filter(d => !d.isDeleted && !d.isVoided)
    .filter(d => toNum(d.stock) <= toNum(d.minStock, 5) && toNum(d.stock) >= 0)
    .map(d => `• ${d.name} (${d.categoryName ?? 'Unknown'}): ${toNum(d.stock)} left [min: ${toNum(d.minStock, 5)}]`)

  const result = items.length === 0
    ? 'All items are sufficiently stocked.'
    : `${items.length} item(s) need restocking:\n${items.join('\n')}`

  aiCache.set(cacheKey, result)
  return result
}

export async function getInventorySummary(): Promise<string> {
  const cacheKey = 'inventory_summary'
  const cached = aiCache.get<string>(cacheKey)
  if (cached) return cached

  const snap = await db().collection('inventory').get()
  const active = snap.docs.filter(d => !(d.data() as Record<string, unknown>).isDeleted)
  let totalValue = 0
  const byCategory: Record<string, { count: number; stock: number }> = {}

  active.forEach(d => {
    const data = d.data() as Record<string, unknown>
    const stock = toNum(data.stock)
    const price = toNum(data.price)
    totalValue += stock * price
    const cat = typeof data.categoryName === 'string' ? data.categoryName : 'Unknown'
    if (!byCategory[cat]) byCategory[cat] = { count: 0, stock: 0 }
    byCategory[cat].count++
    byCategory[cat].stock += stock
  })

  const topCats = Object.entries(byCategory)
    .sort((a, b) => b[1].stock - a[1].stock)
    .slice(0, 5)
    .map(([cat, { count, stock }]) => `• ${cat}: ${count} items, ${stock} units`)
    .join('\n')

  const result = `Total active items: ${active.length}\nTotal inventory value: ${fmt(totalValue)}\n\nTop categories by stock:\n${topCats}`
  aiCache.set(cacheKey, result)
  return result
}

export async function getStockAging(): Promise<string> {
  const cacheKey = 'stock_aging'
  const cached = aiCache.get<string>(cacheKey)
  if (cached) return cached

  const snap = await db().collection('inventory').get()
  const now = Date.now()
  const aged = snap.docs
    .map(d => ({ id: d.id, ...d.data() } as Record<string, unknown>))
    .filter(d => !d.isDeleted && toNum(d.stock) > 0)
    .map(d => {
      const created = toDate(d.createdAt ?? d.dateAdded)
      const daysOld = created ? Math.floor((now - created.getTime()) / 86400000) : null
      return { name: d.name, stock: toNum(d.stock), category: d.categoryName ?? 'Unknown', daysOld }
    })
    .filter(d => d.daysOld !== null && d.daysOld > 30)
    .sort((a, b) => (b.daysOld ?? 0) - (a.daysOld ?? 0))
    .slice(0, 10)

  const result = aged.length === 0
    ? 'No items found sitting in stock for more than 30 days.'
    : `Items in stock 30+ days:\n${aged.map(i => `• ${i.name} (${i.category}): ${i.stock} units, ${i.daysOld} days`).join('\n')}`

  aiCache.set(cacheKey, result)
  return result
}

export async function searchInventory(query: string): Promise<string> {
  if (!query || query.trim().length < 2) return 'Please provide a more specific search term.'
  const q = query.trim().toLowerCase()

  const snap = await db().collection('inventory').get()
  const matches = snap.docs
    .map(d => ({ id: d.id, ...d.data() } as Record<string, unknown>))
    .filter(d => !d.isDeleted)
    .filter(d => {
      const name = String(d.name ?? '').toLowerCase()
      const cat = String(d.categoryName ?? '').toLowerCase()
      return name.includes(q) || cat.includes(q)
    })
    .slice(0, 8)
    .map(d => `• ${d.name} (${d.categoryName ?? 'Unknown'}): ${toNum(d.stock)} in stock @ ${fmt(toNum(d.price))}`)

  return matches.length === 0
    ? `No items found matching "${query}".`
    : `Found ${matches.length} item(s) matching "${query}":\n${matches.join('\n')}`
}

export async function getInventoryByCategory(category: string): Promise<string> {
  const snap = await db().collection('inventory').get()
  const q = category.trim().toLowerCase()
  const items = snap.docs
    .map(d => ({ id: d.id, ...d.data() } as Record<string, unknown>))
    .filter(d => !d.isDeleted && String(d.categoryName ?? '').toLowerCase().includes(q))
    .map(d => `• ${d.name}: ${toNum(d.stock)} units @ ${fmt(toNum(d.price))} (${d.condition ?? 'N/A'})`)

  return items.length === 0
    ? `No items found in category "${category}".`
    : `${items.length} item(s) in "${category}":\n${items.join('\n')}`
}
