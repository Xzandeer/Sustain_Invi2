// salesSummary.ts
// Queries Firestore and returns a compact, token-efficient sales summary
// for use in the hybrid AI forecasting system.
// Only reads summarized aggregates — never passes raw documents to AI.

import { getAdminDb } from '@/lib/firebaseAdmin'

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
  if (typeof v === 'string' || typeof v === 'number') {
    const d = new Date(v)
    return isNaN(d.getTime()) ? null : d
  }
  return null
}

const getSaleDate = (s: Record<string, unknown>) =>
  toDate(s.createdAt ?? s.date ?? s.saleDate)

const getSaleAmount = (s: Record<string, unknown>) =>
  toNum(s.totalAmount ?? s.amount ?? s.total)

export interface DailyStat {
  date: string        // YYYY-MM-DD
  revenue: number
  transactions: number
}

export interface SalesSummary {
  // Last 28 days of daily revenue (for weighted forecast input)
  daily: DailyStat[]
  // Last 7 days vs prior 7 days revenue (week-over-week)
  last7Revenue: number
  prior7Revenue: number
  wowChange: number         // percentage, e.g. +12.5 or -3.2
  // Last 14 days top categories by revenue
  topCategories: Array<{ name: string; revenue: number; units: number }>
  // Metadata
  totalDaysWithData: number
  dataStart: string         // earliest date in range
  dataEnd: string           // most recent date
  canForecast: boolean
  reason?: string
}

export async function getSalesSummary(categoryFilter?: string): Promise<SalesSummary> {
  const db = getAdminDb()
  const now = new Date()
  const wantedCategory = categoryFilter?.trim().toLowerCase() || null

  // Only fetch last 28 days — avoids loading the entire sales collection
  const since = new Date(now)
  since.setDate(since.getDate() - 28)
  since.setHours(0, 0, 0, 0)

  const snap = await db.collection('sales')
    .where('createdAt', '>=', since)
    .get()
    .catch(() => db.collection('sales').get()) // fallback if timestamp index missing

  const docs = snap.docs
    .map(d => ({ id: d.id, ...d.data() } as Record<string, unknown>))
    .filter(d => {
      const dt = getSaleDate(d)
      return dt && dt >= since && dt <= now
    })

  // Aggregate by day
  const byDay: Record<string, { revenue: number; transactions: number }> = {}
  const catRevenue: Record<string, { revenue: number; units: number }> = {}

  docs.forEach(d => {
    const dt = getSaleDate(d)
    if (!dt) return
    const key = dt.toISOString().split('T')[0]

    // Per-category mode: revenue counted only from matching line items
    const allItems = Array.isArray(d.items) ? (d.items as Array<Record<string, unknown>>) : []
    let saleRevenue: number
    let countsAsTransaction: boolean
    if (wantedCategory) {
      const matching = allItems.filter(item =>
        String(item.categoryName ?? item.category ?? '').trim().toLowerCase() === wantedCategory
      )
      saleRevenue = matching.reduce((s, item) => s + toNum(item.price) * toNum(item.quantity, 1), 0)
      countsAsTransaction = matching.length > 0
      if (!countsAsTransaction) return
    } else {
      saleRevenue = getSaleAmount(d)
      countsAsTransaction = true
    }

    if (!byDay[key]) byDay[key] = { revenue: 0, transactions: 0 }
    byDay[key].revenue += saleRevenue
    byDay[key].transactions += 1

    // Category breakdown (last 14 days only)
    const daysAgo = Math.floor((now.getTime() - dt.getTime()) / 86400000)
    if (daysAgo <= 14) {
      const items = Array.isArray(d.items) ? (d.items as Array<Record<string, unknown>>) : []
      items.forEach(item => {
        const cat = String(item.categoryName ?? item.category ?? 'Unknown')
        const rev = toNum(item.price) * toNum(item.quantity, 1)
        const units = toNum(item.quantity, 1)
        if (!catRevenue[cat]) catRevenue[cat] = { revenue: 0, units: 0 }
        catRevenue[cat].revenue += rev
        catRevenue[cat].units += units
      })
    }
  })

  // Build sorted daily array (ascending date, last 28 days)
  const daily: DailyStat[] = Object.entries(byDay)
    .map(([date, stats]) => ({ date, ...stats }))
    .sort((a, b) => a.date.localeCompare(b.date))

  const totalDaysWithData = daily.length

  if (totalDaysWithData < 3) {
    return {
      daily,
      last7Revenue: 0,
      prior7Revenue: 0,
      wowChange: 0,
      topCategories: [],
      totalDaysWithData,
      dataStart: daily[0]?.date ?? '',
      dataEnd: daily[daily.length - 1]?.date ?? '',
      canForecast: false,
      reason: totalDaysWithData === 0
        ? 'No sales data found in the last 28 days.'
        : `Only ${totalDaysWithData} day(s) of data. Need at least 3 days to forecast.`,
    }
  }

  // Week-over-week comparison
  const last7 = daily.filter(d => {
    const daysAgo = Math.floor((now.getTime() - new Date(d.date).getTime()) / 86400000)
    return daysAgo <= 7
  })
  const prior7 = daily.filter(d => {
    const daysAgo = Math.floor((now.getTime() - new Date(d.date).getTime()) / 86400000)
    return daysAgo > 7 && daysAgo <= 14
  })

  const last7Revenue = last7.reduce((s, d) => s + d.revenue, 0)
  const prior7Revenue = prior7.reduce((s, d) => s + d.revenue, 0)
  const wowChange = prior7Revenue > 0
    ? parseFloat(((last7Revenue - prior7Revenue) / prior7Revenue * 100).toFixed(1))
    : 0

  // Top 4 categories by revenue
  const topCategories = Object.entries(catRevenue)
    .map(([name, stats]) => ({ name, ...stats }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 4)

  return {
    daily,
    last7Revenue,
    prior7Revenue,
    wowChange,
    topCategories,
    totalDaysWithData,
    dataStart: daily[0].date,
    dataEnd: daily[daily.length - 1].date,
    canForecast: true,
  }
}
