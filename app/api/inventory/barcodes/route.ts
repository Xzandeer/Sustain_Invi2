// Barcode lookup and backfill.
//
// GET  ?code=000123  → finds the inventory item carrying that barcode.
//                      Used by the point of sale when an item is scanned.
//
// POST                → assigns barcodes to items that don't have one yet.
//                      Admin only. Safe to run repeatedly; it skips items that
//                      already carry a code.
//
// Items created from now on receive a barcode automatically in
// createInventoryVariant(). This exists for stock encoded before that.

import { NextRequest, NextResponse } from 'next/server'
import { collection, getDocs, query, where, limit, doc, updateDoc } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { createItemBarcode, normalizeBarcode } from '@/lib/server/barcodes'
import { getStockStatus, normalizeInventoryCondition, toNumber } from '@/lib/server/salesInventoryMetrics'
import { guardProcessedBy } from '@/lib/server/authorize'

export async function GET(req: NextRequest) {
  try {
    const code = normalizeBarcode(new URL(req.url).searchParams.get('code'))
    if (!code) {
      return NextResponse.json({ error: 'A barcode is required.' }, { status: 400 })
    }

    const snapshot = await getDocs(
      query(collection(db, 'inventory'), where('barcode', '==', code), limit(1))
    )

    if (snapshot.empty) {
      return NextResponse.json(
        { error: `No item found for barcode ${code}.` },
        { status: 404 }
      )
    }

    const found = snapshot.docs[0]
    const data = found.data() as Record<string, unknown>

    // A voided or trashed item must not be sellable, so the scan is rejected
    // rather than quietly adding something that cannot be checked out.
    if (data.isVoided === true) {
      return NextResponse.json({ error: 'That item has been voided.' }, { status: 409 })
    }
    if (data.isDeleted === true) {
      return NextResponse.json({ error: 'That item is in the trash.' }, { status: 409 })
    }

    const stock = toNumber(data.stock ?? data.quantity, 0)
    const reserved = toNumber(data.reservedStock, 0)

    return NextResponse.json({
      item: {
        id: found.id,
        name: typeof data.name === 'string' ? data.name : 'Unnamed Item',
        barcode: code,
        price: toNumber(data.price, 0),
        condition: normalizeInventoryCondition(data.condition),
        categoryId: typeof data.categoryId === 'string' ? data.categoryId : '',
        categoryName:
          (typeof data.categoryName === 'string' && data.categoryName) ||
          (typeof data.category === 'string' && data.category) ||
          'Uncategorized',
        stock,
        reservedStock: reserved,
        availableStock: Math.max(0, stock - reserved),
        stockStatus: getStockStatus(data),
      },
    })
  } catch (error) {
    console.error('GET /api/inventory/barcodes error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>

    const denied = await guardProcessedBy(body.processedBy, 'canManageInventory')
    if (denied) return denied

    const snapshot = await getDocs(collection(db, 'inventory'))

    // Only items genuinely missing a code. Running this twice must not reassign
    // codes already printed on labels stuck to physical stock.
    const missing = snapshot.docs.filter((d) => {
      const value = (d.data() as Record<string, unknown>).barcode
      return typeof value !== 'string' || !value.trim()
    })

    let assigned = 0
    for (const item of missing) {
      const barcode = await createItemBarcode()
      await updateDoc(doc(db, 'inventory', item.id), { barcode })
      assigned += 1
    }

    return NextResponse.json({
      success: true,
      assigned,
      alreadyHadCode: snapshot.size - missing.length,
      total: snapshot.size,
    })
  } catch (error) {
    console.error('POST /api/inventory/barcodes error:', error)
    return NextResponse.json({ error: 'Failed to assign barcodes.' }, { status: 500 })
  }
}
