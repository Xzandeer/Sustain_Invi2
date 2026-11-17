// What is on the shelf, per item and condition.
//
// GET /api/inventory/units/summary
// {
//   pricing: { New: 100, ... },
//   items: {
//     [itemId]: {
//       grades:    [{ grade, count, price }]   in-stock pieces at their condition price
//       ownPriced: [{ grade, count, minPrice, maxPrice }]   pieces with a price of their own
//       ownPieces: [{ id, unitCode, grade, price }]        those pieces one by one, oldest first
//       reserved:  number
//       oldestDays: number | null
//     }
//   }
// }
//
// The POS uses it to offer each condition at its own price; Inventory to show
// what an item's pieces are, not just how many. Quantity-tracked items do not
// appear - their count on the item is the whole story.

import { NextResponse, type NextRequest } from 'next/server'
import { requireActiveUserRequest } from '@/lib/server/authorize'
import { getStoreSettings } from '@/lib/server/storeSettings'
import { loadShelf } from '@/lib/server/shelf'
import { UNIT_GRADES, gradePrice, type UnitGrade } from '@/lib/inventory/units'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const denied = await requireActiveUserRequest(req)
  if (denied) return denied

  try {
    // The pieces are remembered between requests (lib/server/shelf.ts); only
    // the per-piece items are read each time, to see whether they changed.
    const [{ gradePricing }, { base: basePrice, items: shelf }] = await Promise.all([getStoreSettings(), loadShelf()])
    const now = Date.now()

    type Acc = {
      grades: Map<UnitGrade, number>
      own: Map<UnitGrade, number[]>
      ownPieces: Array<{ id: string; unitCode: string; grade: UnitGrade; price: number; receivedMs: number }>
      reserved: number
      oldest: number | null
    }
    const acc = new Map<string, Acc>()
    for (const [itemId, entry] of shelf) {
      if (!basePrice.has(itemId)) continue
      const a: Acc = { grades: new Map(), own: new Map(), ownPieces: [], reserved: entry.reserved, oldest: null }
      for (const p of entry.pieces) {
        if (p.own !== null) {
          a.own.set(p.grade, [...(a.own.get(p.grade) ?? []), p.own])
          a.ownPieces.push({ id: p.id, unitCode: p.unitCode, grade: p.grade, price: p.own, receivedMs: p.receivedMs ?? 0 })
        }
        else a.grades.set(p.grade, (a.grades.get(p.grade) ?? 0) + 1)
        if (p.receivedMs !== null) {
          const days = Math.max(0, Math.floor((now - p.receivedMs) / 86_400_000))
          a.oldest = a.oldest === null ? days : Math.max(a.oldest, days)
        }
      }
      acc.set(itemId, a)
    }

    const items = Object.fromEntries(Array.from(acc.entries()).map(([itemId, a]) => [itemId, {
      grades: UNIT_GRADES.filter((g) => a.grades.has(g)).map((g) => ({
        grade: g,
        count: a.grades.get(g)!,
        price: gradePrice(basePrice.get(itemId) ?? 0, g, gradePricing),
      })),
      ownPriced: UNIT_GRADES.filter((g) => a.own.has(g)).map((g) => ({
        grade: g,
        count: a.own.get(g)!.length,
        minPrice: Math.min(...a.own.get(g)!),
        maxPrice: Math.max(...a.own.get(g)!),
      })),
      // So the POS can sell one with a click, not only by scanning its label.
      ownPieces: a.ownPieces
        .sort((x, y) => x.receivedMs - y.receivedMs)
        .map(({ id, unitCode, grade, price }) => ({ id, unitCode, grade, price })),
      reserved: a.reserved,
      oldestDays: a.oldest,
    }]))

    return NextResponse.json({ pricing: gradePricing, items })
  } catch (error) {
    console.error('GET /api/inventory/units/summary error:', error)
    return NextResponse.json({ error: 'Could not load the shelf summary.' }, { status: 500 })
  }
}
