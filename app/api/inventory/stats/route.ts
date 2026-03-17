import { NextResponse } from 'next/server'
import { getInventoryStats } from '@/app/lib/inventory/inventoryStats'

export async function GET() {
  try {
    const stats = await getInventoryStats()
    return NextResponse.json(stats, { status: 200 })
  } catch (error) {
    console.error('GET /api/inventory/stats error:', error)
    return NextResponse.json({ error: 'Failed to fetch inventory statistics' }, { status: 500 })
  }
}