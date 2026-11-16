// One unit (physical piece).
//
// PATCH /api/inventory/units/[unitId]
//   { grade?, conditionNotes?, priceOverride?: number | null, processedBy }
//
// Re-grading a piece, noting a defect or giving it its own price. Only pieces
// still in the shop (in stock or reserved) can be edited - a sold unit's record
// is what its sale and any refund dispute rely on.

import { NextResponse } from 'next/server'
import { guardRequest } from '@/lib/server/authorize'
import { getAdminDb } from '@/lib/firebaseAdmin'
import { createStockLog, getProcessedByInfo } from '@/lib/server/inventory'
import { forget } from '@/lib/server/readCache'
import { cleanConditionNotes, MAX_PRICE } from '@/lib/constants/limits'
import { UNITS_COLLECTION, UNIT_GRADES, normalizeUnitGrade } from '@/lib/inventory/units'
import { normalizeInventoryCondition, toNumber } from '@/lib/server/salesInventoryMetrics'

interface RouteContext {
  params: Promise<{ unitId: string }>
}

export async function PATCH(req: Request, context: RouteContext) {
  const denied = await guardRequest(req, 'canManageInventory')
  if (denied) return denied

  try {
    const { unitId } = await context.params
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const processedBy = await getProcessedByInfo(req)
    const db = getAdminDb()
    const unitRef = db.collection(UNITS_COLLECTION).doc(unitId)

    const unitSnap = await unitRef.get()
    if (!unitSnap.exists) return NextResponse.json({ error: 'Unit not found.' }, { status: 404 })
    const unit = unitSnap.data() as Record<string, unknown>
    if (unit.status !== 'in_stock' && unit.status !== 'reserved') {
      return NextResponse.json({ error: 'Only pieces still in the shop can be edited.' }, { status: 400 })
    }

    const patch: Record<string, unknown> = {}
    const changes: string[] = []

    if (body.grade !== undefined) {
      if (!(UNIT_GRADES as readonly string[]).includes(body.grade as string)) {
        return NextResponse.json({ error: 'Choose a valid grade.' }, { status: 400 })
      }
      const grade = normalizeUnitGrade(body.grade)
      if (grade !== unit.grade) { patch.grade = grade; changes.push(`Grade: ${unit.grade ?? '-'} -> ${grade}`) }
    }
    if (body.conditionNotes !== undefined) {
      const notes = cleanConditionNotes(body.conditionNotes)
      if (notes !== (unit.conditionNotes ?? '')) { patch.conditionNotes = notes; changes.push('Condition notes updated') }
    }
    if (body.priceOverride !== undefined) {
      const price = body.priceOverride === null || body.priceOverride === '' ? null : toNumber(body.priceOverride, Number.NaN)
      if (price !== null && (!Number.isFinite(price) || price <= 0 || price > MAX_PRICE)) {
        return NextResponse.json({ error: 'Enter a price greater than zero, or clear it to use the item price.' }, { status: 400 })
      }
      if (price !== (unit.priceOverride ?? null)) {
        patch.priceOverride = price
        changes.push(price === null ? 'Own price removed' : `Own price: ₱${price.toLocaleString('en-PH')}`)
      }
    }

    if (changes.length === 0) return NextResponse.json({ success: true, changed: false })

    const nowIso = new Date().toISOString()
    await unitRef.update({ ...patch, updatedAt: nowIso })
    // Mark the item changed too: the remembered shelf (lib/server/shelf.ts)
    // re-reads its pieces when an item's updatedAt moves.
    await db.collection('inventory').doc(String(unit.itemId)).update({ updatedAt: nowIso }).catch(() => {})
    forget('shelf:')

    // The item's own record says which product line this piece belongs to.
    const itemSnap = await db.collection('inventory').doc(String(unit.itemId)).get()
    const item = (itemSnap.data() ?? {}) as Record<string, unknown>
    const stock = Math.max(0, toNumber(item.stock ?? item.quantity, 0))
    const reserved = Math.max(0, toNumber(item.reservedStock, 0))
    await createStockLog({
      actionType: 'item_edited',
      itemId: String(unit.itemId),
      itemName: typeof item.name === 'string' ? item.name : String(unit.itemName ?? ''),
      condition: normalizeInventoryCondition(item.condition),
      quantityBefore: stock,
      quantityChanged: 0,
      quantityAfter: stock,
      stockBefore: stock,
      stockAfter: stock,
      reservedBefore: reserved,
      reservedAfter: reserved,
      user: processedBy,
      units: [{ id: unitId, unitCode: String(unit.unitCode ?? '') }],
      remarks: `Unit #${unit.unitCode} edited. ${changes.join('. ')}.`,
    })

    return NextResponse.json({ success: true, changed: true })
  } catch (error) {
    console.error('PATCH /api/inventory/units/[unitId] error:', error)
    return NextResponse.json({ error: 'Could not update this unit.' }, { status: 500 })
  }
}
