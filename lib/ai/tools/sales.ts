// AI assistant tools - sales questions.
//
// Read-only lookups: today's sales, recent sales, top categories, trend data,
// frequent customers, basket analysis, the dashboard summary and restock
// recommendations. Each returns a formatted string for the chat answer.
// Cached via lib/ai/cache.

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

export async function getTodaySales(): Promise<string> {
  const today = new Date(); today.setHours(0, 0, 0, 0)
  // Query only today's records from Firestore — saves tokens by not loading full history
  const snap = await db().collection('sales')
    .where('createdAt', '>=', today)
    .get()
    .catch(() => db().collection('sales').get()) // fallback if field name differs
  const todaySales = snap.docs
    .map(d => ({ id: d.id, ...d.data() } as Record<string, unknown>))
    .filter(s => { const d = getSaleDate(s); return d && d >= today })

  if (todaySales.length === 0) return `No transactions recorded today (${today.toLocaleDateString('en-PH', { month: 'long', day: 'numeric', year: 'numeric' })}).`

  const revenue = todaySales.reduce((sum, s) => sum + getSaleAmount(s), 0)
  const items = todaySales.reduce((sum, s) => {
    const arr = Array.isArray(s.items) ? (s.items as Array<Record<string, unknown>>) : []
    return sum + arr.reduce((a, i) => a + toNum(i.quantity, 1), 0)
  }, 0)
  return `Today: ${todaySales.length} transaction(s), ${fmt(revenue)} revenue, ${items} items sold.`
}

export async function getRecentSales(days = 30): Promise<string> {
  const cacheKey = `recent_sales_${days}`
  const cached = aiCache.get<string>(cacheKey)
  if (cached) return cached

  const since = new Date(); since.setDate(since.getDate() - days); since.setHours(0, 0, 0, 0)
  // Query only records within date range — avoids loading full sales history
  const snap = await db().collection('sales')
    .where('createdAt', '>=', since)
    .get()
    .catch(() => db().collection('sales').get()) // fallback if field name differs
  const recent = snap.docs
    .map(d => ({ id: d.id, ...d.data() } as Record<string, unknown>))
    .filter(s => { const d = getSaleDate(s); return d && d >= since })

  if (recent.length === 0) { const r = `No sales in the last ${days} days.`; aiCache.set(cacheKey, r); return r }

  const revenue = recent.reduce((sum, s) => sum + getSaleAmount(s), 0)
  const avg = revenue / recent.length
  const result = `Last ${days} days: ${recent.length} transaction(s), ${fmt(revenue)} total revenue, ${fmt(avg)} avg per order.`
  aiCache.set(cacheKey, result)
  return result
}

export async function getTopCategories(): Promise<string> {
  const cacheKey = 'top_categories'
  const cached = aiCache.get<string>(cacheKey)
  if (cached) return cached

  const snap = await db().collection('sales').get()
  const catData: Record<string, { revenue: number; units: number }> = {}

  snap.docs.forEach(d => {
    const data = d.data() as Record<string, unknown>
    const items = Array.isArray(data.items) ? (data.items as Array<Record<string, unknown>>) : []
    items.forEach(item => {
      const cat = typeof item.categoryName === 'string' ? item.categoryName : 'Unknown'
      if (!catData[cat]) catData[cat] = { revenue: 0, units: 0 }
      catData[cat].revenue += toNum(item.price) * toNum(item.quantity, 1)
      catData[cat].units += toNum(item.quantity, 1)
    })
  })

  if (Object.keys(catData).length === 0) { return 'No sales data available yet.' }

  const sorted = Object.entries(catData)
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .slice(0, 6)
    .map(([cat, { revenue, units }], i) => `${i + 1}. ${cat}: ${fmt(revenue)} (${units} units)`)

  const result = `Top categories by revenue:\n${sorted.join('\n')}`
  aiCache.set(cacheKey, result)
  return result
}

export async function getTrendData(): Promise<string> {
  const cacheKey = 'trend_data'
  const cached = aiCache.get<string>(cacheKey)
  if (cached) return cached

  const snap = await db().collection('sales').get()
  const now = new Date()

  // Build last 6 months
  const months: { label: string; start: Date; end: Date; revenue: number; count: number }[] = []
  for (let i = 5; i >= 0; i--) {
    const start = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59)
    months.push({ label: start.toLocaleDateString('en-PH', { month: 'short', year: 'numeric' }), start, end, revenue: 0, count: 0 })
  }

  snap.docs.forEach(d => {
    const data = d.data() as Record<string, unknown>
    const date = getSaleDate(data)
    const amount = getSaleAmount(data)
    if (!date) return
    for (const bucket of months) {
      if (date >= bucket.start && date <= bucket.end) { bucket.revenue += amount; bucket.count++; break }
    }
  })

  const lines = months.map(m => `• ${m.label}: ${fmt(m.revenue)} (${m.count} orders)`)
  const cur = months[months.length - 1]
  const prev = months[months.length - 2]
  const change = prev.revenue > 0 ? (((cur.revenue - prev.revenue) / prev.revenue) * 100).toFixed(1) : 'N/A'
  const direction = prev.revenue > 0 ? (cur.revenue >= prev.revenue ? '▲' : '▼') : ''

  const result = `6-month revenue trend:\n${lines.join('\n')}\n\nMonth-over-month: ${direction} ${change}%`
  aiCache.set(cacheKey, result)
  return result
}

export async function getFrequentCustomers(): Promise<string> {
  const cacheKey = 'frequent_customers'
  const cached = aiCache.get<string>(cacheKey)
  if (cached) return cached

  const snap = await db().collection('sales').get()
  const map: Record<string, { name: string; count: number; total: number }> = {}

  snap.docs.forEach(d => {
    const data = d.data() as Record<string, unknown>
    const name = typeof data.customer === 'string' && data.customer.trim() ? data.customer.trim() : null
    if (!name || name.toLowerCase() === 'walk-in') return
    const email = typeof data.customerEmail === 'string' ? data.customerEmail : name
    if (!map[email]) map[email] = { name, count: 0, total: 0 }
    map[email].count++
    map[email].total += getSaleAmount(data)
  })

  const sorted = Object.values(map).sort((a, b) => b.count - a.count).slice(0, 8)
  if (sorted.length === 0) { return 'No named customer purchase history found.' }

  const result = `Top customers:\n${sorted.map((c, i) => `${i + 1}. ${c.name}: ${c.count} purchase(s), ${fmt(c.total)} total`).join('\n')}`
  aiCache.set(cacheKey, result)
  return result
}

export async function getBasketAnalysis(): Promise<string> {
  const cacheKey = 'basket_analysis'
  const cached = aiCache.get<string>(cacheKey)
  if (cached) return cached

  const snap = await db().collection('sales').get()
  const pairMap: Record<string, number> = {}
  const itemFreq: Record<string, number> = {}

  snap.docs.forEach(d => {
    const data = d.data() as Record<string, unknown>
    const items = Array.isArray(data.items) ? (data.items as Array<Record<string, unknown>>) : []
    const names = items.map(i => String(i.name ?? '').trim()).filter(Boolean)
    names.forEach(n => { itemFreq[n] = (itemFreq[n] ?? 0) + 1 })
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const pair = [names[i], names[j]].sort().join(' + ')
        pairMap[pair] = (pairMap[pair] ?? 0) + 1
      }
    }
  })

  const topItems = Object.entries(itemFreq).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, c]) => `• ${n} (${c}x)`)
  const topPairs = Object.entries(pairMap).filter(([, c]) => c > 1).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([pair, c]) => `• ${pair} (${c}x together)`)

  const result = `Most purchased:\n${topItems.join('\n') || '(not enough data)'}\n\nCommonly bought together:\n${topPairs.join('\n') || '(no repeated pairs yet)'}`
  aiCache.set(cacheKey, result)
  return result
}

export async function getDashboardSummary(): Promise<string> {
  const cacheKey = 'dashboard_summary'
  const cached = aiCache.get<string>(cacheKey)
  if (cached) return cached

  const [invSnap, salesSnap, resSnap] = await Promise.all([
    db().collection('inventory').get(),
    db().collection('sales').get(),
    db().collection('reservations').get(),
  ])

  const today = new Date(); today.setHours(0, 0, 0, 0)
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1)

  const activeInv = invSnap.docs.filter(d => !(d.data() as Record<string, unknown>).isDeleted)
  const lowStock = activeInv.filter(d => { const data = d.data() as Record<string, unknown>; return toNum(data.stock) <= toNum(data.minStock, 5) })
  const outOfStock = activeInv.filter(d => toNum((d.data() as Record<string, unknown>).stock) === 0)

  const allSales = salesSnap.docs.map(d => ({ id: d.id, ...d.data() } as Record<string, unknown>))
  const todaySales = allSales.filter(s => { const d = getSaleDate(s); return d && d >= today })
  const monthSales = allSales.filter(s => { const d = getSaleDate(s); return d && d >= monthStart })

  const activeRes = resSnap.docs.filter(d => { const s = String((d.data() as Record<string, unknown>).status ?? '').toLowerCase(); return s === 'active' || s === 'pending' })

  const result = [
    `Inventory: ${activeInv.length} items | ${lowStock.length} low stock | ${outOfStock.length} out of stock`,
    `Today: ${fmt(todaySales.reduce((s, x) => s + getSaleAmount(x), 0))} revenue (${todaySales.length} orders)`,
    `This month: ${fmt(monthSales.reduce((s, x) => s + getSaleAmount(x), 0))} revenue (${monthSales.length} orders)`,
    `Active reservations: ${activeRes.length}`,
  ].join('\n')

  aiCache.set(cacheKey, result)
  return result
}

// Philippine seasonal context per month — used for AI recommendations
const PH_SEASONAL_CONTEXT: Record<number, { season: string; trends: string[]; holidays: string[] }> = {
  0:  { season: 'New Year Recovery',   trends: ['home appliances', 'bags', 'clothing', 'school supplies'], holidays: ['New Year hangover — customers looking for deals after holiday spending'] },
  1:  { season: 'Valentines',          trends: ['accessories', 'clothing', 'bags', 'personal care'],      holidays: ["Valentine's Day (Feb 14) — gifts, fashion items trending"] },
  2:  { season: 'Summer Prep',         trends: ['electronics', 'fans', 'footwear', 'clothing'],           holidays: ['Start of PH summer — outdoor gear, fans, cooling appliances trending'] },
  3:  { season: 'Holy Week / Summer',  trends: ['fans', 'appliances', 'footwear', 'bags'],                holidays: ['Holy Week travel — bags and footwear in demand; Lenten season'] },
  4:  { season: 'Summer Peak',         trends: ['electronics', 'fans', 'footwear', 'clothing'],           holidays: ['Labor Day (May 1) — full summer; cooling appliances and outdoor items peak'] },
  5:  { season: 'Ber Month Start',     trends: ['school supplies', 'bags', 'clothing', 'electronics'],    holidays: ['June — school opening season; school supplies and bags highly in demand'] },
  6:  { season: 'Rainy Season',        trends: ['appliances', 'clothing', 'home goods'],                  holidays: ['July — rainy season; indoor appliances and home items popular'] },
  7:  { season: 'Back to School',      trends: ['school supplies', 'bags', 'electronics', 'clothing'],    holidays: ['August — school season continues; National Heroes Day (Aug 26)'] },
  8:  { season: 'Ber Month / Ber Rush',trends: ['electronics', 'clothing', 'bags', 'accessories'],        holidays: ["September — Christmas season STARTS in PH; 'Ber months' shoppers begin holiday prep"] },
  9:  { season: 'Pre-Christmas',       trends: ['electronics', 'clothing', 'bags', 'home appliances'],    holidays: ['October — Christmas shopping picks up; gift items and home decor trending'] },
  10: { season: 'Christmas Rush',      trends: ['electronics', 'appliances', 'clothing', 'accessories', 'bags'], holidays: ['November — major Christmas shopping rush; All Saints Day (Nov 1); Bonifacio Day (Nov 30)'] },
  11: { season: 'Christmas Peak',      trends: ['electronics', 'appliances', 'clothing', 'footwear', 'bags', 'accessories'], holidays: ['December — peak Christmas season; Christmas Day (Dec 25); family gift-giving; highest retail month in PH'] },
}

export async function getRecommendations(): Promise<string> {
  const cacheKey = 'recommendations'
  const cached = aiCache.get<string>(cacheKey)
  if (cached) return cached

  const [invSnap, salesSnap] = await Promise.all([
    db().collection('inventory').get(),
    db().collection('sales').get(),
  ])

  const now = new Date()
  const monthIndex = now.getMonth()
  const monthName = now.toLocaleDateString('en-PH', { month: 'long' })
  const day = now.toLocaleDateString('en-PH', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  const seasonal = PH_SEASONAL_CONTEXT[monthIndex]

  // Top categories from actual sales
  const catSales: Record<string, { revenue: number; units: number }> = {}
  salesSnap.docs.forEach(d => {
    const data = d.data() as Record<string, unknown>
    const items = Array.isArray(data.items) ? (data.items as Array<Record<string, unknown>>) : []
    items.forEach(item => {
      const cat = typeof item.categoryName === 'string' ? item.categoryName : 'Unknown'
      if (!catSales[cat]) catSales[cat] = { revenue: 0, units: 0 }
      catSales[cat].revenue += toNum(item.price) * toNum(item.quantity, 1)
      catSales[cat].units += toNum(item.quantity, 1)
    })
  })

  const topCats = Object.entries(catSales)
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .slice(0, 5)
    .map(([cat, { revenue, units }]) => `• ${cat}: ${fmt(revenue)} revenue, ${units} units sold`)

  // Match inventory with seasonal trending categories
  const trendingCategories = seasonal.trends.map(t => t.toLowerCase())
  const allItems = invSnap.docs
    .map(d => ({ id: d.id, ...d.data() } as Record<string, unknown>))
    .filter(d => !d.isDeleted && toNum(d.stock) > 0)

  // Items that match seasonal trends and have good stock
  const seasonalMatches = allItems
    .filter(d => {
      const cat = String(d.categoryName ?? '').toLowerCase()
      return trendingCategories.some(t => cat.includes(t) || t.includes(cat))
    })
    .sort((a, b) => toNum(b.stock) - toNum(a.stock))
    .slice(0, 6)
    .map(d => `• ${d.name} (${d.categoryName ?? 'Unknown'}): ${toNum(d.stock)} units @ ${fmt(toNum(d.price))}`)

  // High stock items regardless of season (need to move inventory)
  const highStock = allItems
    .sort((a, b) => toNum(b.stock) - toNum(a.stock))
    .slice(0, 5)
    .map(d => `• ${d.name} (${d.categoryName ?? 'Unknown'}): ${toNum(d.stock)} units @ ${fmt(toNum(d.price))}`)

  const result = [
    `Store: JMGS Japan Surplus (Philippine surplus retail shop)`,
    `Date: ${day}`,
    `Current Season: ${seasonal.season}`,
    `Philippine Context: ${seasonal.holidays.join('; ')}`,
    `Trending in PH this month: ${seasonal.trends.join(', ')}`,
    ``,
    `Items in stock that match this month's PH trends:`,
    seasonalMatches.length > 0 ? seasonalMatches.join('\n') : '(no matching items in current inventory)',
    ``,
    `Highest stock items (prioritize moving these):`,
    highStock.join('\n') || '(no data)',
    ``,
    `Your store top-selling categories (all time):`,
    topCats.join('\n') || '(no sales data yet)',
  ].join('\n')

  aiCache.set(cacheKey, result)
  return result
}
