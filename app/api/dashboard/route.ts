import { NextResponse } from 'next/server'
import { collection, getDocs } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { computeDashboardMetrics, InventoryRecord, SaleRecord } from '@/lib/server/salesInventoryMetrics'

export async function GET() {
  try {
    const [salesSnapshot, inventorySnapshot] = await Promise.all([
      getDocs(collection(db, 'sales')),
      getDocs(collection(db, 'inventory')),
    ])

    const sales = salesSnapshot.docs.map((saleDoc) => ({
      id: saleDoc.id,
      ...saleDoc.data(),
    })) as SaleRecord[]

    const inventory = inventorySnapshot.docs
      .map((inventoryDoc) => ({
        id: inventoryDoc.id,
        ...inventoryDoc.data(),
      }) as InventoryRecord)
      .filter((item) => item.isDeleted !== true) as InventoryRecord[]

    const metrics = computeDashboardMetrics(sales, inventory)
    return NextResponse.json({ data: metrics }, { status: 200 })
  } catch (error) {
    console.error('GET /api/dashboard error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
