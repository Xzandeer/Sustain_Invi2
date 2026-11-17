// Stock adjustment API - POST to add/deduct/transfer stock between conditions
import { NextResponse } from 'next/server'
import { MAX_STOCK, cleanConditionNotes, INPUT_LIMITS } from '@/lib/constants/limits'
import { normalizeUnitGrade } from '@/lib/inventory/units'
import {
  allocateUnitCodes, describeUnits, isUnitTracked, pickUnits, readItemUnits, setUnitsStatus, writeNewUnits,
  type StoredUnit,
} from '@/lib/server/units'
import { getAdminDb } from '@/lib/firebaseAdmin'
import {
  createInventoryVariant,
  createStockLog,
  findInventoryVariant,
  getProcessedByInfo,
} from '@/lib/server/inventory'
import { InventoryCondition, getStockStatus, normalizeInventoryCondition, toNumber } from '@/lib/server/salesInventoryMetrics'
import { guardRequest } from '@/lib/server/authorize'

interface RouteContext {
  params: Promise<{ id: string }>
}

interface AdjustPayload {
  action?: unknown // 'add', 'deduct', 'transfer'
  quantity?: unknown
  targetCondition?: unknown // 'New' or 'Refurbished' (for transfers)
  remarks?: unknown
  processedBy?: unknown
  /** Unit-tracked items, deduct/transfer: the exact pieces. Otherwise oldest first. */
  unitIds?: unknown
  /** Unit-tracked items, add: grade, notes and optional own price of the new pieces. */
  unitGrade?: unknown
  unitNotes?: unknown
  unitPrice?: unknown
}

// ── Unit-tracked adjustments ────────────────────────────────────────────────
//
// add       new pieces arrive: one unit each, with the grade/notes given
// deduct    pieces leave the books (damaged, lost): the named units, or the
//           oldest on the shelf, become written_off
// transfer  pieces move between New and Refurbished: the same units (same
//           codes and labels) are re-pointed at the other condition's record
//
// Each runs as one transaction with the item's counts. Reserved pieces are
// never touched - only in-stock units are read.
async function adjustUnits(ctx: {
  id: string
  action: string
  quantity: number
  remarks: string
  processedBy: Awaited<ReturnType<typeof getProcessedByInfo>>
  body: AdjustPayload
  itemName: string
  categoryId: string
  categoryName: string
  price: number
  minStock: number
  description?: string
  imageUrl?: string
  sourceCondition: InventoryCondition
}) {
  const db = getAdminDb()
  const sourceRef = db.collection('inventory').doc(ctx.id)
  const nowIso = new Date().toISOString()
  const requestedIds = Array.isArray(ctx.body.unitIds)
    ? ctx.body.unitIds.filter((v): v is string => typeof v === 'string' && v.length > 0)
    : []

  try {
    if (ctx.action === 'add') {
      const priceInput = toNumber(ctx.body.unitPrice, Number.NaN)
      const codes = await allocateUnitCodes(ctx.quantity)
      let before = { stock: 0, reserved: 0 }
      let created: ReturnType<typeof writeNewUnits> = []
      await db.runTransaction(async (txn) => {
        const snap = await txn.get(sourceRef)
        const d = (snap.data() ?? {}) as Record<string, unknown>
        before = { stock: Math.max(0, toNumber(d.stock ?? d.quantity, 0)), reserved: Math.max(0, toNumber(d.reservedStock, 0)) }
        const next = before.stock + ctx.quantity
        txn.update(sourceRef, {
          stock: next, quantity: next,
          stockStatus: getStockStatus({ stock: next, minStock: ctx.minStock }),
          updatedAt: nowIso,
        })
        created = writeNewUnits(txn, {
          itemId: ctx.id,
          itemName: ctx.itemName,
          codes,
          details: {
            grade: normalizeUnitGrade(ctx.body.unitGrade),
            conditionNotes: cleanConditionNotes(ctx.body.unitNotes),
            priceOverride: Number.isFinite(priceInput) && priceInput > 0 ? priceInput : null,
          },
          nowIso,
          source: 'stock_increased',
        })
      })
      const after = before.stock + ctx.quantity
      await createStockLog({
        actionType: 'stock_increased',
        itemId: ctx.id, itemName: ctx.itemName, condition: ctx.sourceCondition,
        quantityBefore: before.stock, quantityChanged: ctx.quantity, quantityAfter: after,
        stockBefore: before.stock, stockAfter: after, reservedBefore: before.reserved, reservedAfter: before.reserved,
        user: ctx.processedBy,
        units: created.map((u) => ({ id: u.id, unitCode: u.unitCode, grade: u.grade })),
        remarks: (ctx.remarks || 'Manual stock increase.') + describeUnits(created),
      })
      return NextResponse.json({ success: true, units: created.map((u) => ({ id: u.id, unitCode: u.unitCode, grade: u.grade })) }, { status: 200 })
    }

    if (ctx.action === 'deduct') {
      let before = { stock: 0, reserved: 0 }
      let removed: StoredUnit[] = []
      await db.runTransaction(async (txn) => {
        const snap = await txn.get(sourceRef)
        const d = (snap.data() ?? {}) as Record<string, unknown>
        before = { stock: Math.max(0, toNumber(d.stock ?? d.quantity, 0)), reserved: Math.max(0, toNumber(d.reservedStock, 0)) }
        const pool = await readItemUnits(txn, ctx.id, 'in_stock')
        removed = pickUnits(pool, ctx.quantity, requestedIds, ctx.itemName, { allowOverridePrices: true })
        const next = before.stock - ctx.quantity
        if (next < before.reserved) throw new Error('UNITS_UNAVAILABLE:Reserved stock cannot be reduced.')
        txn.update(sourceRef, {
          stock: next, quantity: next,
          stockStatus: getStockStatus({ stock: next, minStock: ctx.minStock }),
          updatedAt: nowIso,
        })
        setUnitsStatus(txn, removed, 'written_off', nowIso)
      })
      const after = before.stock - ctx.quantity
      await createStockLog({
        actionType: 'stock_decreased',
        itemId: ctx.id, itemName: ctx.itemName, condition: ctx.sourceCondition,
        quantityBefore: before.stock, quantityChanged: -ctx.quantity, quantityAfter: after,
        stockBefore: before.stock, stockAfter: after, reservedBefore: before.reserved, reservedAfter: before.reserved,
        user: ctx.processedBy,
        units: removed.map((u) => ({ id: u.id, unitCode: u.unitCode, grade: u.grade })),
        remarks: (ctx.remarks || 'Manual stock deduction.') + describeUnits(removed),
      })
      return NextResponse.json({ success: true }, { status: 200 })
    }

    // transfer
    const targetCondition = normalizeInventoryCondition(ctx.body.targetCondition) as InventoryCondition
    if (targetCondition === ctx.sourceCondition) {
      return NextResponse.json({ error: 'Select a different condition for transfer.' }, { status: 400 })
    }
    const existingTarget = await findInventoryVariant({ name: ctx.itemName, categoryId: ctx.categoryId, condition: targetCondition })
    // A new variant starts empty; the moved units become its stock.
    const targetId = existingTarget?.id ?? (await createInventoryVariant({
      name: ctx.itemName,
      categoryId: ctx.categoryId,
      categoryName: ctx.categoryName,
      price: ctx.price,
      quantity: 0,
      minStock: ctx.minStock,
      condition: targetCondition,
      description: ctx.description,
      imageUrl: ctx.imageUrl,
      trackingMode: 'unit',
    })).id
    const targetRef = db.collection('inventory').doc(targetId)

    let source = { stock: 0, reserved: 0 }
    let target = { stock: 0, reserved: 0, minStock: ctx.minStock }
    let moved: StoredUnit[] = []
    await db.runTransaction(async (txn) => {
      const [sSnap, tSnap] = await Promise.all([txn.get(sourceRef), txn.get(targetRef)])
      const sd = (sSnap.data() ?? {}) as Record<string, unknown>
      const td = (tSnap.data() ?? {}) as Record<string, unknown>
      if (td.trackingMode !== 'unit') {
        throw new Error('UNITS_UNAVAILABLE:The other condition of this item counts quantity only, so pieces cannot be moved into it.')
      }
      source = { stock: Math.max(0, toNumber(sd.stock ?? sd.quantity, 0)), reserved: Math.max(0, toNumber(sd.reservedStock, 0)) }
      target = { stock: Math.max(0, toNumber(td.stock ?? td.quantity, 0)), reserved: Math.max(0, toNumber(td.reservedStock, 0)), minStock: Math.max(0, toNumber(td.minStock, 0)) }
      const pool = await readItemUnits(txn, ctx.id, 'in_stock')
      moved = pickUnits(pool, ctx.quantity, requestedIds, ctx.itemName, { allowOverridePrices: true })
      const nextSource = source.stock - ctx.quantity
      const nextTarget = target.stock + ctx.quantity
      txn.update(sourceRef, { stock: nextSource, quantity: nextSource, stockStatus: getStockStatus({ stock: nextSource, minStock: ctx.minStock }), updatedAt: nowIso })
      txn.update(targetRef, { stock: nextTarget, quantity: nextTarget, stockStatus: getStockStatus({ stock: nextTarget, minStock: target.minStock }), updatedAt: nowIso })
      for (const u of moved) txn.update(u.ref, { itemId: targetId, updatedAt: nowIso })
    })
    const unitsRef = moved.map((u) => ({ id: u.id, unitCode: u.unitCode, grade: u.grade }))
    await createStockLog({
      actionType: 'stock_transferred_out',
      itemId: ctx.id, itemName: ctx.itemName, condition: ctx.sourceCondition,
      quantityBefore: source.stock, quantityChanged: -ctx.quantity, quantityAfter: source.stock - ctx.quantity,
      stockBefore: source.stock, stockAfter: source.stock - ctx.quantity, reservedBefore: source.reserved, reservedAfter: source.reserved,
      user: ctx.processedBy, units: unitsRef, relatedId: targetId,
      remarks: (ctx.remarks || `Transferred stock to ${targetCondition}.`) + describeUnits(moved),
    })
    await createStockLog({
      actionType: 'stock_transferred_in',
      itemId: targetId, itemName: ctx.itemName, condition: targetCondition,
      quantityBefore: target.stock, quantityChanged: ctx.quantity, quantityAfter: target.stock + ctx.quantity,
      stockBefore: target.stock, stockAfter: target.stock + ctx.quantity, reservedBefore: target.reserved, reservedAfter: target.reserved,
      user: ctx.processedBy, units: unitsRef, relatedId: ctx.id,
      remarks: (ctx.remarks || `Transferred stock from ${ctx.sourceCondition}.`) + describeUnits(moved),
    })
    return NextResponse.json({ success: true }, { status: 200 })
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('UNITS_UNAVAILABLE:')) {
      return NextResponse.json({ error: error.message.slice('UNITS_UNAVAILABLE:'.length) }, { status: 400 })
    }
    throw error
  }
}

// POST /api/inventory/[id]/adjust - Adjust stock (add/deduct/transfer between conditions)
export async function POST(req: Request, context: RouteContext) {
  try {
    // Step 1: Parse request
    const { id } = await context.params
    const body = (await req.json()) as AdjustPayload
    const action = typeof body.action === 'string' ? body.action.trim().toLowerCase() : ''
    const quantity = Math.floor(toNumber(body.quantity, Number.NaN))
    const remarks = typeof body.remarks === 'string' ? body.remarks.trim().slice(0, INPUT_LIMITS.note) : ''

    // Adjusting stock changes the books, so it needs the same permission as
    // editing an item. Checked before anything is read or written.
    const denied = await guardRequest(req, 'canManageInventory')
    if (denied) return denied

    const processedBy = await getProcessedByInfo(req)

    // Step 2: Validate action and quantity
    if (!id || !['add', 'deduct', 'transfer'].includes(action)) {
      return NextResponse.json({ error: 'Invalid stock adjustment request.' }, { status: 400 })
    }

    if (!Number.isFinite(quantity) || quantity <= 0) {
      return NextResponse.json({ error: 'Adjustment quantity must be greater than zero.' }, { status: 400 })
    }

    if (quantity > MAX_STOCK) {
      return NextResponse.json(
        { error: `Adjustment quantity cannot exceed ${MAX_STOCK}.` },
        { status: 400 }
      )
    }

    // Step 3: Get current item data
    const snapshot = await getAdminDb().collection('inventory').doc(id).get()
    if (!snapshot.exists) {
      return NextResponse.json({ error: 'Item not found.' }, { status: 404 })
    }

    const data = snapshot.data() as Record<string, unknown>

    // A voided or trashed item must not take stock movements. Both are excluded
    // from sales and reservations, so adding stock here would produce units that
    // exist on the books but can never be sold. The UI hides the button; this is
    // the check that actually enforces it.
    if (data.isVoided === true) {
      return NextResponse.json(
        { error: 'This item is voided. Restore it before adjusting stock.' },
        { status: 400 }
      )
    }
    if (data.isDeleted === true) {
      return NextResponse.json(
        { error: 'This item is in the trash. Restore it before adjusting stock.' },
        { status: 400 }
      )
    }

    // A single item is one physical unit. Adding stock would turn it into a
    // count of several "identical" units, which is exactly what it exists to
    // avoid; transferring it would merge it into an ordinary stock line and
    // lose its own condition and price. Only a deduction - the unit is gone -
    // makes sense.
    if (data.isSingleItem === true && action !== 'deduct') {
      return NextResponse.json(
        {
          error:
            action === 'add'
              ? 'This is a single item and always holds one unit. Add the other unit as its own item.'
              : 'A single item cannot be transferred. Edit its condition notes instead.',
        },
        { status: 400 }
      )
    }

    const sourceCondition = normalizeInventoryCondition(data.condition)
    const itemName = typeof data.name === 'string' ? data.name.trim() : ''
    const categoryId = typeof data.categoryId === 'string' ? data.categoryId.trim() : ''
    const categoryName =
      (typeof data.categoryName === 'string' && data.categoryName.trim()) ||
      (typeof data.category === 'string' && data.category.trim()) ||
      'Uncategorized'
    const price = Math.max(0, toNumber(data.price, 0))
    const minStock = Math.max(0, toNumber(data.minStock, 0))
    const description = typeof data.description === 'string' ? data.description : undefined
    const imageUrl = typeof data.imageUrl === 'string' ? data.imageUrl : undefined
    const currentStock = Math.max(0, toNumber(data.stock ?? data.quantity, 0))
    const currentReservedStock = Math.max(0, toNumber(data.reservedStock, 0))
    const availableStock = Math.max(0, currentStock - currentReservedStock)
    const sourceRef = getAdminDb().collection('inventory').doc(id)

    // Step 4: Validate item has required fields
    if (!itemName || !categoryId) {
      return NextResponse.json({ error: 'Inventory variant is missing required fields.' }, { status: 400 })
    }

    // Unit-tracked items move real pieces, not just a number - see adjustUnits.
    if (isUnitTracked(data)) {
      return adjustUnits({
        id, action, quantity, remarks, processedBy, body,
        itemName, categoryId, categoryName, price, minStock, description, imageUrl, sourceCondition,
      })
    }

    // Step 5: Handle ADD action (simple stock increase)
    if (action === 'add') {
      const nextStock = currentStock + quantity
      await sourceRef.update({
        stock: nextStock,
        quantity: nextStock,
        stockStatus: getStockStatus({ stock: nextStock, minStock }),
        updatedAt: new Date().toISOString(),
      })

      await createStockLog({
        actionType: 'stock_increased',
        itemId: id,
        itemName,
        condition: sourceCondition,
        quantityBefore: currentStock,
        quantityChanged: quantity,
        quantityAfter: nextStock,
        stockBefore: currentStock,
        stockAfter: nextStock,
        reservedBefore: currentReservedStock,
        reservedAfter: currentReservedStock,
        user: processedBy,
        remarks: remarks || 'Manual stock increase.',
      })

      return NextResponse.json({ success: true }, { status: 200 })
    }

    // Step 6: Check sufficient available stock for deduct/transfer (reserved can't be touched)
    if (quantity > availableStock) {
      return NextResponse.json(
        { error: 'Adjustment exceeds available stock. Reserved stock cannot be reduced.' },
        { status: 400 }
      )
    }

    // Step 7: Handle DEDUCT action (simple stock decrease)
    if (action === 'deduct') {
      const nextStock = currentStock - quantity
      await sourceRef.update({
        stock: nextStock,
        quantity: nextStock,
        stockStatus: getStockStatus({ stock: nextStock, minStock }),
        updatedAt: new Date().toISOString(),
      })

      await createStockLog({
        actionType: 'stock_decreased',
        itemId: id,
        itemName,
        condition: sourceCondition,
        quantityBefore: currentStock,
        quantityChanged: quantity * -1,
        quantityAfter: nextStock,
        stockBefore: currentStock,
        stockAfter: nextStock,
        reservedBefore: currentReservedStock,
        reservedAfter: currentReservedStock,
        user: processedBy,
        remarks: remarks || 'Manual stock deduction.',
      })

      return NextResponse.json({ success: true }, { status: 200 })
    }

    // Step 8: Handle TRANSFER action (move stock between conditions - New <-> Refurbished)
    const targetCondition = normalizeInventoryCondition(body.targetCondition) as InventoryCondition
    if (targetCondition === sourceCondition) {
      return NextResponse.json({ error: 'Select a different condition for transfer.' }, { status: 400 })
    }

    // Step 9: Find or prepare target variant (other condition of same item)
    const targetVariant = await findInventoryVariant({
      name: itemName,
      categoryId,
      condition: targetCondition,
    })

    const nextSourceStock = currentStock - quantity
    let targetId = targetVariant?.id ?? ''
    let targetStockBefore = targetVariant?.stock ?? 0
    let targetReservedBefore = targetVariant?.reservedStock ?? 0
    let targetMinStock = targetVariant?.minStock ?? minStock

    // Step 10: Reduce source stock
    await sourceRef.update({
      stock: nextSourceStock,
      quantity: nextSourceStock,
      stockStatus: getStockStatus({ stock: nextSourceStock, minStock }),
      updatedAt: new Date().toISOString(),
    })

    // Step 11: Update or create target variant
    if (targetVariant) {
      const nextTargetStock = targetVariant.stock + quantity
      await getAdminDb().collection('inventory').doc(targetVariant.id).update({
        stock: nextTargetStock,
        quantity: nextTargetStock,
        price,
        minStock: targetVariant.minStock,
        stockStatus: getStockStatus({ stock: nextTargetStock, minStock: targetVariant.minStock }),
        updatedAt: new Date().toISOString(),
      })
    } else {
      // Create new variant for target condition
      const created = await createInventoryVariant({
        name: itemName,
        categoryId,
        categoryName,
        price,
        quantity,
        minStock,
        condition: targetCondition,
        description,
        imageUrl,
      })
      targetId = created.id
      targetStockBefore = 0
      targetReservedBefore = 0
      targetMinStock = minStock
    }

    const nextTargetStock = targetStockBefore + quantity

    // Step 12: Log transfer OUT from source
    await createStockLog({
      actionType: 'stock_transferred_out',
      itemId: id,
      itemName,
      condition: sourceCondition,
      quantityBefore: currentStock,
      quantityChanged: quantity * -1,
      quantityAfter: nextSourceStock,
      stockBefore: currentStock,
      stockAfter: nextSourceStock,
      reservedBefore: currentReservedStock,
      reservedAfter: currentReservedStock,
      user: processedBy,
      remarks: remarks || `Transferred stock to ${targetCondition}.`,
      relatedId: targetId,
    })


    return NextResponse.json({ success: true }, { status: 200 })
  } catch (error) {
    console.error('POST /api/inventory/[id]/adjust error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
