// Inventory counters for the dashboard cards.
//
// GET → total items, total stock value, low-stock and out-of-stock counts.
// The counting logic lives in lib/inventory/inventoryStats.ts.

import { NextResponse } from 'next/server'
import { getInventoryStats } from '@/lib/inventory/inventoryStats'

export async function GET() {
  try {
    const stats = await getInventoryStats()
    return NextResponse.json(stats, { status: 200 })
  } catch (error) {
    console.error('GET /api/inventory/stats error:', error)
    return NextResponse.json({ error: 'Failed to fetch inventory statistics' }, { status: 500 })
  }
}