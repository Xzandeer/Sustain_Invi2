// The pieces on the shelf, per per-piece item - read once and remembered.
//
// Reading every piece costs one Firestore read per piece, and the POS, the
// Dashboard, Inventory and the assistant all ask for it. The pieces only change
// when an item's stock, holds or record change (a sale, a delivery, a refund, a
// reservation, an adjustment, a piece edit - each updates the item's
// updatedAt), so each request reads just the per-piece items (a few dozen
// documents) and re-reads the pieces only when those differ from last time.
//
// Prices are not remembered: they come from the item's current base price and
// the store's condition pricing at the time of the request.

import { getAdminDb } from '@/lib/firebaseAdmin'
import { UNITS_COLLECTION, normalizeUnitGrade, type UnitGrade } from '@/lib/inventory/units'
import { toNumber } from '@/lib/server/salesInventoryMetrics'
import { fingerprint, remember } from '@/lib/server/readCache'

export interface ShelfPiece {
  id: string
  unitCode: string
  grade: UnitGrade
  /** A price of its own, or null to sell at its condition's price. */
  own: number | null
  receivedMs: number | null
}
export interface ShelfEntry {
  /** In-stock pieces (held ones are only counted). */
  pieces: ShelfPiece[]
  reserved: number
}
export interface Shelf {
  /** Base (New) price of every per-piece item. */
  base: Map<string, number>
  items: Map<string, ShelfEntry>
}

// A safety net for writes that change pieces without touching their item.
const MAX_AGE_MS = 10 * 60_000

const stamp = (v: unknown): string => {
  const ts = v as { toMillis?: () => number } | null
  return typeof ts?.toMillis === 'function' ? String(ts.toMillis()) : String(v ?? '')
}

export async function loadShelf(): Promise<Shelf> {
  const db = getAdminDb()
  const itemsSnap = await db.collection('inventory').where('trackingMode', '==', 'unit').get()
  const base = new Map(itemsSnap.docs.map((d) => [d.id, Math.max(0, toNumber((d.data() as Record<string, unknown>).price, 0))]))
  const version = fingerprint(itemsSnap.docs.map((d) => {
    const x = d.data() as Record<string, unknown>
    return `${d.id}:${x.stock}:${x.reservedStock}:${stamp(x.updatedAt)}:${x.isDeleted === true}`
  }))

  const items = await remember('shelf:pieces', MAX_AGE_MS, async () => {
    const unitsSnap = await db.collection(UNITS_COLLECTION).where('status', 'in', ['in_stock', 'reserved']).get()
    const out = new Map<string, ShelfEntry>()
    for (const d of unitsSnap.docs) {
      const u = d.data() as Record<string, unknown>
      const itemId = String(u.itemId ?? '')
      const entry = out.get(itemId) ?? { pieces: [], reserved: 0 }
      if (u.status === 'reserved') entry.reserved++
      else {
        const received = Date.parse(String(u.receivedAt ?? ''))
        entry.pieces.push({
          id: d.id,
          unitCode: typeof u.unitCode === 'string' ? u.unitCode : '',
          grade: normalizeUnitGrade(u.grade),
          own: typeof u.priceOverride === 'number' && u.priceOverride > 0 ? u.priceOverride : null,
          receivedMs: Number.isNaN(received) ? null : received,
        })
      }
      out.set(itemId, entry)
    }
    return out
  }, version)

  return { base, items }
}
