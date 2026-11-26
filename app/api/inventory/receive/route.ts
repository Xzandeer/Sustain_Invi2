// Receive stock - a batch of pieces arriving, each with its own condition.
//
// POST /api/inventory/receive
// {
//   itemId?:      add to this item; otherwise found by name + category, or created
//   name, categoryId, basePrice, minStock?, description?
//   trackingMode: 'unit' (default) | 'quantity'
//   pieces:       unit tracking - one entry per piece:
//                 [{ grade, conditionNotes?, priceOverride? }]
//   quantity, grade:  quantity tracking - how many, and their one condition
//   source?:      shipment / where it came from
//   processedBy
// }
//
// One item holds every condition (lib/inventory/units.ts): there are no
// separate New and Refurbished records. The item's New/Refurbished field is
// kept for older reports and worked out from what it holds.
//
// Returns the item id and the new pieces (code, condition, price) so their
// labels can be printed straight away.

import { NextResponse, type NextRequest } from 'next/server'
import { guardRequest } from '@/lib/server/authorize'
import { getAdminDb } from '@/lib/firebaseAdmin'
import { MAX_PRICE, MAX_STOCK, cleanConditionNotes, INPUT_LIMITS } from '@/lib/constants/limits'
import { createInventoryVariant, createStockLog, getProcessedByInfo } from '@/lib/server/inventory'
import { getStockStatus, toNumber } from '@/lib/server/salesInventoryMetrics'
import { getStoreSettings } from '@/lib/server/storeSettings'
import { allocateUnitCodes, describeUnits, unitPrice, writeNewUnits } from '@/lib/server/units'
import {
  UNITS_COLLECTION, UNIT_GRADES, legacyConditionOf, normalizeUnitGrade, type UnitDetails, type UnitGrade,
} from '@/lib/inventory/units'

const normalizeName = (v: string) => v.trim().replace(/\s+/g, ' ').toLowerCase()

export async function POST(req: NextRequest) {
  const denied = await guardRequest(req, 'canManageInventory')
  if (denied) return denied

  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const processedBy = await getProcessedByInfo(req)
    const db = getAdminDb()

    const trackingMode = body.trackingMode === 'quantity' ? 'quantity' : 'unit'
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, INPUT_LIMITS.name) : ''
    const categoryIdInput = typeof body.categoryId === 'string' ? body.categoryId.trim() : ''
    const basePrice = toNumber(body.basePrice, Number.NaN)
    const minStockInput = toNumber(body.minStock, Number.NaN)
    const description = typeof body.description === 'string' ? body.description.trim().slice(0, 500) : ''
    const source = typeof body.source === 'string' ? body.source.trim().slice(0, INPUT_LIMITS.source) : ''

    // ── The pieces ──
    const pieces: UnitDetails[] = trackingMode === 'unit'
      ? (Array.isArray(body.pieces) ? body.pieces : []).map((raw) => {
          const r = (raw ?? {}) as Record<string, unknown>
          const own = toNumber(r.priceOverride, Number.NaN)
          return {
            grade: normalizeUnitGrade(r.grade),
            conditionNotes: cleanConditionNotes(r.conditionNotes),
            priceOverride: Number.isFinite(own) && own > 0 && own <= MAX_PRICE ? own : null,
          }
        })
      : []
    const quantity = trackingMode === 'unit' ? pieces.length : Math.floor(toNumber(body.quantity, Number.NaN))
    const quantityGrade: UnitGrade = normalizeUnitGrade(body.grade)

    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > MAX_STOCK) {
      return NextResponse.json({ error: `Receive between 1 and ${MAX_STOCK} pieces.` }, { status: 400 })
    }
    if (!Number.isFinite(basePrice) || basePrice <= 0 || basePrice > MAX_PRICE) {
      return NextResponse.json({ error: 'Enter a base price greater than zero.' }, { status: 400 })
    }

    // ── The item: given, found by name, or new ──
    let itemRef: FirebaseFirestore.DocumentReference | null = null
    // True only when this request creates the item (for the stock log label).
    let createdNow = false
    if (typeof body.itemId === 'string' && body.itemId) {
      const snap = await db.collection('inventory').doc(body.itemId).get()
      if (!snap.exists) return NextResponse.json({ error: 'Item not found.' }, { status: 404 })
      const d = snap.data() as Record<string, unknown>
      // Written-off items can take new stock (see below); deleted ones cannot.
      if (d.isDeleted === true) {
        return NextResponse.json({ error: 'Restore this item before receiving stock for it.' }, { status: 400 })
      }
      itemRef = snap.ref
    } else {
      if (!name || !categoryIdInput) {
        return NextResponse.json({ error: 'Item name and category are required.' }, { status: 400 })
      }
      // Same name and category is the same item - whatever condition its pieces
      // are in. A single item (one-off piece) never takes more stock.
      const sameCategory = await db.collection('inventory').where('categoryId', '==', categoryIdInput).get()
      const match = sameCategory.docs.find((d) => {
        const data = d.data() as Record<string, unknown>
        return data.isDeleted !== true && data.isSingleItem !== true &&
          normalizeName(typeof data.name === 'string' ? data.name : '') === normalizeName(name)
      })
      // A written-off item of that name is the same product: the new pieces go
      // to it and bring it back on sale (below).
      itemRef = match?.ref ?? null
    }

    if (!itemRef) {
      const category = await db.collection('categories').doc(categoryIdInput).get()
      if (!category.exists) return NextResponse.json({ error: 'Category not found.' }, { status: 404 })
      const categoryName = String((category.data() as Record<string, unknown>).name ?? '').trim() || 'Uncategorized'
      const created = await createInventoryVariant({
        name,
        categoryId: categoryIdInput,
        categoryName,
        price: basePrice,
        quantity: 0,
        minStock: Number.isFinite(minStockInput) && minStockInput >= 0 ? Math.min(MAX_STOCK, Math.floor(minStockInput)) : 0,
        condition: 'New',
        description,
        trackingMode,
      })
      itemRef = db.collection('inventory').doc(created.id)
      createdNow = true
    }

    // ── Add the pieces with the count, in one transaction ──
    const { gradePricing } = await getStoreSettings()
    const codes = trackingMode === 'unit' ? await allocateUnitCodes(quantity) : []
    const nowIso = new Date().toISOString()
    let before = { stock: 0, reserved: 0, name: '', condition: 'New' as 'New' | 'Refurbished', mode: trackingMode as string, price: basePrice }
    let created: ReturnType<typeof writeNewUnits> = []
    let wasWrittenOff = false

    await db.runTransaction(async (txn) => {
      const snap = await txn.get(itemRef!)
      const d = (snap.data() ?? {}) as Record<string, unknown>
      const mode = d.trackingMode === 'unit' ? 'unit' : 'quantity'
      if (mode !== trackingMode) {
        throw new Error(mode === 'unit'
          ? 'RECEIVE:This item tracks each piece. Add it piece by piece.'
          : 'RECEIVE:This item counts quantity only. Add it as a quantity.')
      }
      // What the item already holds, for its New/Refurbished field.
      const held = mode === 'unit'
        ? (await txn.get(db.collection(UNITS_COLLECTION).where('itemId', '==', itemRef!.id).where('status', 'in', ['in_stock', 'reserved'])))
            .docs.map((u) => normalizeUnitGrade((u.data() as Record<string, unknown>).grade))
        : (Math.max(0, toNumber(d.stock ?? d.quantity, 0)) > 0 ? [normalizeUnitGrade(d.grade ?? (d.condition === 'Refurbished' ? 'Good' : 'New'))] : [])
      const incoming = mode === 'unit' ? pieces.map((p) => p.grade ?? 'Good') : [quantityGrade]

      before = {
        stock: Math.max(0, toNumber(d.stock ?? d.quantity, 0)),
        reserved: Math.max(0, toNumber(d.reservedStock, 0)),
        name: typeof d.name === 'string' ? d.name : name,
        condition: legacyConditionOf([...held, ...incoming]),
        mode,
        price: basePrice,
      }
      const minStock = Math.max(0, toNumber(d.minStock, 0))
      const next = before.stock + quantity
      // New stock for a fully written-off item - say every old piece broke and
      // a fresh batch arrived. The item comes back on sale with the NEW pieces
      // only; the old ones stay written off (voidedUnits keeps the record).
      // Before, Add stock refused and the only way back was Restore, which
      // put every broken piece back on sale too.
      wasWrittenOff = d.isVoided === true
      txn.update(itemRef!, {
        stock: next,
        quantity: next,
        // The batch's base price becomes the item's - what a New piece sells for.
        price: basePrice,
        condition: before.condition,
        status: before.condition,
        ...(mode === 'quantity' ? { grade: quantityGrade } : {}),
        stockStatus: getStockStatus({ stock: next, minStock }),
        isDeleted: false,
        deletedAt: null,
        ...(wasWrittenOff ? { isVoided: false } : {}),
        updatedAt: nowIso,
      })
      if (mode === 'unit') {
        created = writeNewUnits(txn, {
          itemId: itemRef!.id,
          itemName: before.name,
          codes,
          detailsList: pieces,
          nowIso,
          source: source || 'receive_stock',
        })
      }
    })

    // "9 Good, 3 Fair" for the audit trail.
    const tally = UNIT_GRADES
      .map((g) => [g, before.mode === 'unit' ? pieces.filter((p) => p.grade === g).length : g === quantityGrade ? quantity : 0] as const)
      .filter(([, n]) => n > 0)
      .map(([g, n]) => `${n} ${g}`)
      .join(', ')
    await createStockLog({
      // "Item added" only for a new item. Restocking a sold-out or written-off
      // item used to log as "Item added" too, as if it were a new product.
      actionType: createdNow ? 'item_added' : 'stock_increased',
      itemId: itemRef.id,
      itemName: before.name,
      condition: before.condition,
      quantityBefore: before.stock,
      quantityChanged: quantity,
      quantityAfter: before.stock + quantity,
      stockBefore: before.stock,
      stockAfter: before.stock + quantity,
      reservedBefore: before.reserved,
      reservedAfter: before.reserved,
      user: processedBy,
      units: created.map((u) => ({ id: u.id, unitCode: u.unitCode, grade: u.grade })),
      remarks: `Received ${quantity}: ${tally}.${source ? ` From ${source}.` : ''}` + describeUnits(created) +
        (wasWrittenOff ? ' The item had been written off; it is back on sale with these pieces only - the written-off pieces stay written off.' : ''),
    })

    return NextResponse.json({
      success: true,
      itemId: itemRef.id,
      units: created.map((u) => ({
        id: u.id,
        unitCode: u.unitCode,
        grade: u.grade,
        price: unitPrice(u, basePrice, gradePricing),
      })),
    })
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('RECEIVE:')) {
      return NextResponse.json({ error: error.message.slice('RECEIVE:'.length) }, { status: 400 })
    }
    console.error('POST /api/inventory/receive error:', error)
    return NextResponse.json({ error: 'Could not receive this stock.' }, { status: 500 })
  }
}
