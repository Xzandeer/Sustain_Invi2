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
import { getAdminDb } from '@/lib/firebaseAdmin'
import { createItemBarcode, normalizeBarcode } from '@/lib/server/barcodes'
import { getStockStatus, normalizeInventoryCondition, toNumber } from '@/lib/server/salesInventoryMetrics'
import { guardRequest, requireActiveUserRequest } from '@/lib/server/authorize'
import { UNITS_COLLECTION, UNIT_GRADES, gradePrice, isUnitCode, normalizeUnitGrade } from '@/lib/inventory/units'
import { getStoreSettings } from '@/lib/server/storeSettings'

export async function GET(req: NextRequest) {
  // Read access is checked here, not left to the database rules: this route
  // uses the Admin SDK, which bypasses the rules entirely. Without this line
  // the data below is returned to anyone on the internet who calls the URL.
  const denied = await requireActiveUserRequest(req)
  if (denied) return denied

  try {
    const code = normalizeBarcode(new URL(req.url).searchParams.get('code'))
    if (!code) {
      return NextResponse.json({ error: 'A barcode is required.' }, { status: 400 })
    }

    // An 8-digit code is one physical piece (lib/inventory/units.ts): find it,
    // make sure it is still on the shelf, and answer with its item plus the
    // unit, so the cart adds that exact piece at its own price.
    let unit: { id: string; unitCode: string; grade: string; conditionNotes: string; price: number | null; ownPrice?: boolean } | null = null
    let found: FirebaseFirestore.DocumentSnapshot
    if (isUnitCode(code)) {
      const unitSnap = await getAdminDb().collection(UNITS_COLLECTION).where('unitCode', '==', code).limit(1).get()
      if (unitSnap.empty) {
        return NextResponse.json({ error: `No item found for code ${code}.` }, { status: 404 })
      }
      const u = unitSnap.docs[0].data() as Record<string, unknown>
      if (u.status !== 'in_stock') {
        const why = u.status === 'sold' ? 'has already been sold' : u.status === 'reserved' ? 'is reserved for a customer' : 'has been written off'
        return NextResponse.json({ error: `That piece (#${code}) ${why}.` }, { status: 409 })
      }
      unit = {
        id: unitSnap.docs[0].id,
        unitCode: code,
        grade: typeof u.grade === 'string' ? u.grade : 'Good',
        conditionNotes: typeof u.conditionNotes === 'string' ? u.conditionNotes : '',
        price: typeof u.priceOverride === 'number' && u.priceOverride > 0 ? u.priceOverride : null,
      }
      found = await getAdminDb().collection('inventory').doc(String(u.itemId)).get()
      if (!found.exists) {
        return NextResponse.json({ error: `No item found for code ${code}.` }, { status: 404 })
      }
      const { gradePricing } = await getStoreSettings()
      const base = toNumber((found.data() as Record<string, unknown>).price, 0)
      unit = {
        ...unit,
        grade: normalizeUnitGrade(unit.grade),
        // Always a price: its own, or its condition's share of the base.
        price: unit.price ?? gradePrice(base, normalizeUnitGrade(unit.grade), gradePricing),
        ownPrice: unit.price !== null,
      } as typeof unit
    } else {
      const snapshot = await getAdminDb()
        .collection('inventory')
        .where('barcode', '==', code)
        .limit(1)
        .get()

      if (snapshot.empty) {
        return NextResponse.json(
          { error: `No item found for barcode ${code}.` },
          { status: 404 }
        )
      }
      found = snapshot.docs[0]
      // An item merged into another (one record per item - see
      // scripts/backfill-units.js) still has its old labels on the shelf.
      const mergedInto = (found.data() as Record<string, unknown>).mergedInto
      if (typeof mergedInto === 'string' && mergedInto) {
        const target = await getAdminDb().collection('inventory').doc(mergedInto).get()
        if (target.exists) found = target
      }
    }

    const data = found.data() as Record<string, unknown>

    // A unit-tracked item scanned by its item barcode rather than a piece label:
    // which conditions are on the shelf, at what price, so the counter can pick.
    let grades: Array<{ grade: string; count: number; price: number }> | undefined
    if (!unit && data.trackingMode === 'unit') {
      const [{ gradePricing }, unitsSnap] = await Promise.all([
        getStoreSettings(),
        getAdminDb().collection(UNITS_COLLECTION).where('itemId', '==', found.id).where('status', '==', 'in_stock').get(),
      ])
      const counts = new Map<string, number>()
      unitsSnap.docs.forEach((d) => {
        const u = d.data() as Record<string, unknown>
        if (typeof u.priceOverride === 'number' && u.priceOverride > 0) return
        const g = normalizeUnitGrade(u.grade)
        counts.set(g, (counts.get(g) ?? 0) + 1)
      })
      const base = toNumber(data.price, 0)
      grades = UNIT_GRADES.filter((g) => counts.has(g)).map((g) => ({ grade: g, count: counts.get(g)!, price: gradePrice(base, g, gradePricing) }))
    }

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
        // Carried into the cart so a scanned one-off shows its own condition
        // notes, the same as one picked from the list.
        isSingleItem: data.isSingleItem === true,
        conditionNotes: typeof data.conditionNotes === 'string' ? data.conditionNotes : '',
        trackingMode: data.trackingMode === 'unit' ? 'unit' : 'quantity',
      },
      // Present when a unit label was scanned: the exact piece to add.
      ...(unit ? { unit } : {}),
      // Present for a unit-tracked item scanned by its item barcode.
      ...(grades ? { grades } : {}),
    })
  } catch (error) {
    console.error('GET /api/inventory/barcodes error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>

    const denied = await guardRequest(req, 'canManageInventory')
    if (denied) return denied

    const snapshot = await getAdminDb().collection('inventory').get()

    // Only items genuinely missing a code. Running this twice must not reassign
    // codes already printed on labels stuck to physical stock.
    const missing = snapshot.docs.filter((d) => {
      const value = (d.data() as Record<string, unknown>).barcode
      return typeof value !== 'string' || !value.trim()
    })

    let assigned = 0
    for (const item of missing) {
      const barcode = await createItemBarcode()
      await getAdminDb().collection('inventory').doc(item.id).update({ barcode })
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
