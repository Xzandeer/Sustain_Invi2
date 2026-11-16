// What individual unit records reveal that quantities cannot.
//
// GET /api/inventory/units/insights
//   aging        pieces on the shelf now, per category: how many, average and
//                oldest days since they arrived, and how many are past 60 days
//   timeToSell   pieces sold in the last 180 days, per grade: how many and the
//                average / median days from arrival to sale
//   slowest      the eight pieces that have waited longest on the shelf
//
// Shown on Analytics (components/analytics/UnitInsights). Revenue figures stay
// with the sales data; this is about how stock moves.

import { NextResponse, type NextRequest } from 'next/server'
import { guardRequest } from '@/lib/server/authorize'
import { getAdminDb } from '@/lib/firebaseAdmin'
import { UNITS_COLLECTION, UNIT_GRADES, normalizeUnitGrade } from '@/lib/inventory/units'
import { fingerprint, remember } from '@/lib/server/readCache'

export const dynamic = 'force-dynamic'

const DAY = 86_400_000
const STALE_DAYS = 60
const SOLD_WINDOW_DAYS = 180
// Pieces only change when an item's stock, holds or record change, so the
// answer is reused until one does (or 15 minutes pass, for the day counts).
const MAX_AGE_MS = 15 * 60_000

const stamp = (v: unknown): string => {
  const ts = v as { toMillis?: () => number } | null
  return typeof ts?.toMillis === 'function' ? String(ts.toMillis()) : String(v ?? '')
}

const median = (values: number[]) => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
const round1 = (n: number) => Math.round(n * 10) / 10

export async function GET(req: NextRequest) {
  const denied = await guardRequest(req, 'canViewAnalytics')
  if (denied) return denied

  try {
    const db = getAdminDb()
    const inventorySnap = await db.collection('inventory').get()
    const version = fingerprint(inventorySnap.docs.map((d) => {
      const x = d.data() as Record<string, unknown>
      return `${d.id}:${x.stock}:${x.reservedStock}:${stamp(x.updatedAt)}:${x.categoryName ?? x.category}:${x.name}`
    }))
    const payload = await remember('insights', MAX_AGE_MS, async () => {
      const now = Date.now()
      const soldSince = new Date(now - SOLD_WINDOW_DAYS * DAY).toISOString()

      const [inStockSnap, soldSnap] = await Promise.all([
        db.collection(UNITS_COLLECTION).where('status', '==', 'in_stock').get(),
        db.collection(UNITS_COLLECTION).where('soldAt', '>=', soldSince).get(),
      ])

      const items = new Map(inventorySnap.docs.map((d) => {
        const data = d.data() as Record<string, unknown>
        return [d.id, {
          name: typeof data.name === 'string' ? data.name : 'Item',
          category: (typeof data.categoryName === 'string' && data.categoryName) || (typeof data.category === 'string' && data.category) || 'Uncategorized',
        }]
      }))

      // ── Aging: what is on the shelf, and for how long ──
      const aging = new Map<string, number[]>()
      const shelf: Array<{ unitCode: string; itemName: string; category: string; grade: string; days: number }> = []
      for (const d of inStockSnap.docs) {
        const u = d.data() as Record<string, unknown>
        const received = Date.parse(String(u.receivedAt ?? ''))
        if (Number.isNaN(received)) continue
        const days = Math.max(0, Math.floor((now - received) / DAY))
        const item = items.get(String(u.itemId)) ?? { name: String(u.itemName ?? 'Item'), category: 'Uncategorized' }
        aging.set(item.category, [...(aging.get(item.category) ?? []), days])
        shelf.push({ unitCode: String(u.unitCode ?? ''), itemName: item.name, category: item.category, grade: normalizeUnitGrade(u.grade), days })
      }

      // ── Time to sell, by grade ──
      const sold = new Map<string, number[]>()
      for (const d of soldSnap.docs) {
        const u = d.data() as Record<string, unknown>
        if (u.status !== 'sold') continue
        const received = Date.parse(String(u.receivedAt ?? ''))
        const soldAt = Date.parse(String(u.soldAt ?? ''))
        if (Number.isNaN(received) || Number.isNaN(soldAt) || soldAt < received) continue
        const grade = normalizeUnitGrade(u.grade)
        sold.set(grade, [...(sold.get(grade) ?? []), (soldAt - received) / DAY])
      }

      const allShelfDays = shelf.map((s) => s.days)
      return {
        summary: {
          onShelf: shelf.length,
          averageDaysOnShelf: round1(allShelfDays.reduce((a, b) => a + b, 0) / Math.max(1, allShelfDays.length)),
          staleCount: allShelfDays.filter((d) => d > STALE_DAYS).length,
          staleDays: STALE_DAYS,
          soldWindowDays: SOLD_WINDOW_DAYS,
        },
        aging: Array.from(aging.entries())
          .map(([category, days]) => ({
            category,
            count: days.length,
            averageDays: round1(days.reduce((a, b) => a + b, 0) / days.length),
            oldestDays: Math.max(...days),
            staleCount: days.filter((d) => d > STALE_DAYS).length,
          }))
          .sort((a, b) => b.averageDays - a.averageDays),
        timeToSell: UNIT_GRADES
          .map((grade) => {
            const days = sold.get(grade) ?? []
            return {
              grade,
              count: days.length,
              averageDays: round1(days.reduce((a, b) => a + b, 0) / Math.max(1, days.length)),
              medianDays: round1(median(days)),
            }
          })
          .filter((g) => g.count > 0),
        slowest: shelf.sort((a, b) => b.days - a.days).slice(0, 8),
      }
    }, version)
    return NextResponse.json(payload)
  } catch (error) {
    console.error('GET /api/inventory/units/insights error:', error)
    return NextResponse.json({ error: 'Could not load unit insights.' }, { status: 500 })
  }
}
