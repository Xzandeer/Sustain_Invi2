// salesSummary.ts
// Queries Firestore and returns a compact, token-efficient sales summary
// for use in the hybrid AI forecasting system.
// Only reads summarized aggregates — never passes raw documents to AI.

import { getAdminDb } from '@/lib/firebaseAdmin'
import { getSalesHistoryTotals } from '@/lib/server/salesHistory'
import { remember } from '@/lib/server/readCache'

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

// What the shop kept: the amount paid, less anything refunded since.
const getSaleAmount = (s: Record<string, unknown>) =>
  Math.max(0, toNum(s.totalAmount ?? s.amount ?? s.total) - toNum(s.refundedAmount))

// A line's pieces still with the customer, and their share of any discount.
const keptLineValue = (s: Record<string, unknown>, item: Record<string, unknown>) => {
  const items = Array.isArray(s.items) ? (s.items as Array<Record<string, unknown>>) : []
  const listValue = items.reduce((sum, i) => sum + toNum(i.price) * toNum(i.quantity, 1), 0)
  const paid = toNum(s.totalAmount ?? s.amount ?? s.total, listValue)
  const share = listValue > 0 && paid > 0 && paid < listValue ? paid / listValue : 1
  const kept = Math.max(0, toNum(item.quantity, 1) - toNum(item.refundedQuantity))
  return { units: kept, revenue: kept * toNum(item.price) * share }
}

// Shop days are Manila days, whatever timezone the server runs in.
const manilaDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' })
const dayKey = (d: Date) => manilaDay.format(d)

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

  // Bounded by date. (This used to fall back to reading every sale ever made.)
  // One read serves every category for 10 minutes: Analytics asks once per
  // category, and the forecast leaves today out, so new sales do not change it.
  // A refund clears it at once (forget('sales:') in the refund route).
  const raw = await remember(`sales:summary:${since.getTime()}`, 10 * 60_000, async () => {
    const snap = await db.collection('sales').where('createdAt', '>=', since).get()
    return snap.docs.map(d => ({ id: d.id, ...d.data() } as Record<string, unknown>))
  })

  const docs = raw
    .filter(d => String(d.status ?? '').toLowerCase() !== 'voided')
    .filter(d => {
      const dt = getSaleDate(d)
      return dt && dt >= since && dt <= now
    })

  const todayKey = dayKey(now)

  // Aggregate by day
  const byDay: Record<string, { revenue: number; transactions: number }> = {}
  const catRevenue: Record<string, { revenue: number; units: number }> = {}

  docs.forEach(d => {
    const dt = getSaleDate(d)
    if (!dt) return
    const key = dayKey(dt)

    // Per-category mode: revenue counted only from matching line items
    const allItems = Array.isArray(d.items) ? (d.items as Array<Record<string, unknown>>) : []
    let saleRevenue: number
    let countsAsTransaction: boolean
    if (wantedCategory) {
      const matching = allItems.filter(item =>
        String(item.categoryName ?? item.category ?? '').trim().toLowerCase() === wantedCategory
      )
      saleRevenue = matching.reduce((sum, item) => sum + keptLineValue(d, item).revenue, 0)
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
        const { revenue: rev, units } = keptLineValue(d, item)
        if (!catRevenue[cat]) catRevenue[cat] = { revenue: 0, units: 0 }
        catRevenue[cat].revenue += rev
        catRevenue[cat].units += units
      })
    }
  })

  // Imported notebook history (whole-store totals only, so not used when the
  // forecast is scoped to one category). On a date that has an imported total,
  // that total replaces whatever was recorded - the two are never added.
  if (!wantedCategory) {
    // Up to and including today (Philippine date); later dates stay hidden.
    const history = await getSalesHistoryTotals(dayKey(since), dayKey(now))
    history.forEach((total, key) => {
      byDay[key] = { revenue: total, transactions: Math.max(1, byDay[key]?.transactions ?? 0) }
    })
  }

  // One entry for EVERY day of the window, up to yesterday:
  //   - a day with no sales is a real zero. Leaving it out made the average a
  //     mean of good days only, so quiet stretches - and slow categories,
  //     which sell on few days - were forecast far too high;
  //   - today is not finished. Counting it, with the highest weight, pulled
  //     every morning's forecast down.
  const daily: DailyStat[] = []
  for (let t = since.getTime(); ; t += 86_400_000) {
    const key = dayKey(new Date(t))
    if (key >= todayKey) break
    if (daily.length && daily[daily.length - 1].date === key) continue
    daily.push({ date: key, revenue: byDay[key]?.revenue ?? 0, transactions: byDay[key]?.transactions ?? 0 })
  }
  // Days before the first recorded sale are not zeros, just no data yet.
  const firstSale = daily.findIndex((d) => d.transactions > 0)
  if (firstSale > 0) daily.splice(0, firstSale)

  const totalDaysWithData = daily.filter((d) => d.transactions > 0).length

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
