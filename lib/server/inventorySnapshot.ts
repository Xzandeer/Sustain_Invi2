// Stock on hand, summarised for the AI review of the forecast.
//
// A surplus shop can only sell what is on the shelf, so the language model is
// told how much stock there is. Only totals are sent - item counts, units,
// low/out-of-stock counts and the priciest one-off pieces - never anything
// about customers or individual sales.

import { getAdminDb } from '@/lib/firebaseAdmin'

export interface InventoryContext {
  scope: string            // category name, or 'whole store'
  itemLines: number        // inventory lines on sale
  unitsInStock: number
  unitsAvailable: number   // in stock minus reserved
  lowStockLines: number
  outOfStockLines: number
  singleItems: Array<{ name: string; price: number }> // unsold one-offs, priciest first
  singleItemCount: number
}

const num = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : Number(v) || 0)

export async function getInventoryContext(category?: string): Promise<InventoryContext | null> {
  try {
    const snap = await getAdminDb().collection('inventory').get()
    const wanted = category?.trim().toLowerCase() || null
    const rows = snap.docs
      .map((d) => d.data() as Record<string, unknown>)
      .filter((d) => d.isDeleted !== true && d.isVoided !== true)
      .filter((d) => {
        if (!wanted) return true
        const cat = String(d.categoryName ?? d.category ?? '').trim().toLowerCase()
        return cat === wanted
      })

    let unitsInStock = 0, unitsAvailable = 0, low = 0, out = 0
    const singles: Array<{ name: string; price: number }> = []
    for (const d of rows) {
      const stock = Math.max(0, num(d.stock ?? d.quantity))
      const reserved = Math.max(0, num(d.reservedStock))
      const min = Math.max(0, num(d.minStock))
      unitsInStock += stock
      unitsAvailable += Math.max(0, stock - reserved)
      if (stock === 0) out += 1
      else if (d.isSingleItem !== true && stock <= min) low += 1
      if (d.isSingleItem === true && stock > 0) {
        singles.push({ name: String(d.name ?? 'Item'), price: num(d.price) })
      }
    }
    singles.sort((a, b) => b.price - a.price)

    return {
      scope: category || 'whole store',
      itemLines: rows.length,
      unitsInStock,
      unitsAvailable,
      lowStockLines: low,
      outOfStockLines: out,
      singleItems: singles.slice(0, 5),
      singleItemCount: singles.length,
    }
  } catch (error) {
    // Inventory context is optional. A failure must not stop the forecast.
    console.warn('[inventorySnapshot] Could not read inventory:', error)
    return null
  }
}
