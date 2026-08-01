// Inventory counters used by GET /api/inventory/stats.
//
// Reads the inventory and categories collections and counts:
//   totalItems      - active items (soft-deleted ones are excluded)
//   lowStock        - stock at or below the item's reorder point, but not zero
//   outOfStock      - stock of zero
//   totalStock      - total units on hand across every item
//   totalCategories - how many categories exist
//
// "Low stock" and "out of stock" are decided by getStockStatus() in
// lib/server/salesInventoryMetrics, the same helper the Inventory page uses,
// so the badge on screen and the number in this count can never disagree.

import { collection, getDocs } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import {
  getStockStatus,
  toNumber,
  type InventoryRecord,
} from '@/lib/server/salesInventoryMetrics'

export interface InventoryStats {
  totalItems: number
  lowStock: number
  outOfStock: number
  totalStock: number
  totalCategories: number
}

export async function getInventoryStats(): Promise<InventoryStats> {
  const [inventorySnapshot, categoriesSnapshot] = await Promise.all([
    getDocs(collection(db, 'inventory')),
    getDocs(collection(db, 'categories')),
  ])

  // Soft-deleted items live in the trash screen and must not be counted here
  const items = inventorySnapshot.docs
    .map((itemDoc) => ({ id: itemDoc.id, ...(itemDoc.data() as InventoryRecord) }))
    .filter((item) => item.isDeleted !== true)

  let lowStock = 0
  let outOfStock = 0
  let totalStock = 0

  for (const item of items) {
    totalStock += toNumber(item.stock ?? item.quantity, 0)

    const status = getStockStatus(item)
    if (status === 'Out of Stock') outOfStock += 1
    else if (status === 'Low Stock') lowStock += 1
  }

  return {
    totalItems: items.length,
    lowStock,
    outOfStock,
    totalStock,
    totalCategories: categoriesSnapshot.size,
  }
}
