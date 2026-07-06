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

export async function predictSales(): Promise<string> {
  const cacheKey = 'predict_sales'
  const cached = aiCache.get<string>(cacheKey)
  if (cached) return cached

  const snap = await db().collection('sales').get()
  const now = new Date()

  // Build daily revenue for last 90 days
  const daily: Record<string, number> = {}
  snap.docs.forEach(d => {
    const data = d.data() as Record<string, unknown>
    const date = getSaleDate(data)
    if (!date) return
    const daysAgo = Math.floor((now.getTime() - date.getTime()) / 86400000)
    if (daysAgo < 0 || daysAgo > 90) return
    const key = date.toISOString().split('T')[0]
    daily[key] = (daily[key] ?? 0) + getSaleAmount(data)
  })

  const dailyValues = Object.values(daily)
  const totalSalesCount = snap.docs.length

  if (totalSalesCount === 0) {
    return JSON.stringify({
      canPredict: false,
      reason: 'NO_SALES_DATA',
      explanation: 'There are no sales recorded in the system yet. The prediction model needs actual transaction history to generate forecasts.',
      whatIsNeeded: 'At least 7 days with completed sales transactions.',
      suggestion: 'Start recording sales in the system and come back after a week of activity.',
    })
  }

  if (dailyValues.length < 7) {
    return JSON.stringify({
      canPredict: false,
      reason: 'INSUFFICIENT_DAYS',
      explanation: `Only ${dailyValues.length} day(s) of sales data found in the last 90 days. The prediction model needs at least 7 different days of sales to detect patterns and trends.`,
      currentData: `${totalSalesCount} total sale(s) across ${dailyValues.length} day(s)`,
      whatIsNeeded: `${7 - dailyValues.length} more day(s) of sales activity needed.`,
      suggestion: 'Keep recording daily sales. Once you have a week of data, the AI can start generating accurate forecasts.',
    })
  }

  // Average daily revenue (last 30 days vs last 60 days to detect trend)
  const last30: number[] = []
  const last60to30: number[] = []
  Object.entries(daily).forEach(([key, val]) => {
    const daysAgo = Math.floor((now.getTime() - new Date(key).getTime()) / 86400000)
    if (daysAgo <= 30) last30.push(val)
    else if (daysAgo <= 60) last60to30.push(val)
  })

  const avg30 = last30.length > 0 ? last30.reduce((a, b) => a + b, 0) / last30.length : 0
  const avg60 = last60to30.length > 0 ? last60to30.reduce((a, b) => a + b, 0) / last60to30.length : avg30

  // Trend factor
  const trendFactor = avg60 > 0 ? avg30 / avg60 : 1
  const trendPct = ((trendFactor - 1) * 100).toFixed(1)
  const trendDir = trendFactor >= 1 ? 'upward' : 'downward'

  // Seasonal multiplier — learned from store's own historical data per month
  const month = now.getMonth() // 0-11
  const monthName = now.toLocaleDateString('en-PH', { month: 'long' })

  // Build per-month averages from all historical data (up to 2 years)
  const twoYearsAgo = new Date(); twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2)
  const monthlyAvg: Record<number, { total: number; days: Set<string> }> = {}
  for (let m = 0; m < 12; m++) monthlyAvg[m] = { total: 0, days: new Set() }

  snap.docs.forEach(d => {
    const data = d.data() as Record<string, unknown>
    const date = getSaleDate(data)
    if (!date || date < twoYearsAgo) return
    const m = date.getMonth()
    monthlyAvg[m].total += getSaleAmount(data)
    monthlyAvg[m].days.add(date.toISOString().split('T')[0])
  })

  // Calculate per-month daily average, then ratio vs overall average
  const monthDailyAvgs = Object.entries(monthlyAvg).map(([m, { total, days }]) => ({
    month: Number(m),
    avg: days.size > 0 ? total / days.size : 0,
  }))
  const overallAvg = monthDailyAvgs.reduce((s, x) => s + x.avg, 0) / 12 || avg30

  // Seasonal multiplier: ratio of this month's historical avg vs overall avg
  // Fallback to Philippine retail defaults if no data for a month
  const defaultMultipliers: Record<number, number> = {
    0: 0.85, 1: 0.90, 2: 0.95, 3: 0.95, 4: 1.00,
    5: 0.95, 6: 0.90, 7: 0.95, 8: 1.00, 9: 1.05, 10: 1.10, 11: 1.25,
  }
  const thisMonthAvg = monthDailyAvgs.find(x => x.month === month)?.avg ?? 0
  const learnedMultiplier = thisMonthAvg > 0 && overallAvg > 0 ? thisMonthAvg / overallAvg : null
  const seasonal = learnedMultiplier ?? defaultMultipliers[month] ?? 1.0
  const multiplierSource = learnedMultiplier ? 'learned from your store data' : 'using Philippine retail baseline'

  // Projections
  const projectedDailyAvg = avg30 * trendFactor * seasonal
  const projectedWeek = projectedDailyAvg * 7
  const projectedWeekLow = projectedWeek * 0.85
  const projectedWeekHigh = projectedWeek * 1.15

  // Days remaining in current month
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  const dayOfMonth = now.getDate()
  const daysRemaining = daysInMonth - dayOfMonth
  const earnedThisMonth = Object.entries(daily)
    .filter(([key]) => {
      const d = new Date(key)
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()
    })
    .reduce((sum, [, val]) => sum + val, 0)
  const projectedMonthTotal = earnedThisMonth + (projectedDailyAvg * daysRemaining)

  // Top category this month
  const catSnap = await db().collection('sales').get()
  const catRevenue: Record<string, number> = {}
  catSnap.docs.forEach(d => {
    const data = d.data() as Record<string, unknown>
    const date = getSaleDate(data)
    if (!date) return
    const daysAgo = Math.floor((now.getTime() - date.getTime()) / 86400000)
    if (daysAgo > 30) return
    const items = Array.isArray(data.items) ? (data.items as Array<Record<string, unknown>>) : []
    items.forEach(item => {
      const cat = typeof item.categoryName === 'string' ? item.categoryName : 'Unknown'
      catRevenue[cat] = (catRevenue[cat] ?? 0) + toNum(item.price) * toNum(item.quantity, 1)
    })
  })
  const topCat = Object.entries(catRevenue).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'N/A'

  const result = [
    `Based on last 30-day average: ${fmt(avg30)}/day`,
    `Trend: ${trendDir} (${trendPct}% vs previous 30 days)`,
    `Seasonal factor: ${monthName} = ${((seasonal - 1) * 100).toFixed(0)}% ${seasonal >= 1 ? 'boost' : 'slowdown'} (${multiplierSource})`,
    `Next 7 days projection: ${fmt(projectedWeekLow)} – ${fmt(projectedWeekHigh)}`,
    `${monthName} projected total: ${fmt(projectedMonthTotal)} (${fmt(earnedThisMonth)} earned so far, ${daysRemaining} days left)`,
    `Strongest category right now: ${topCat}`,
    `Note: Predictions are estimates based on historical patterns. Surplus inventory can vary.`,
  ].join('\n')

  aiCache.set(cacheKey, result)
  return result
}
