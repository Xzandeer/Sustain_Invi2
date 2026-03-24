import { NextResponse } from 'next/server'
import { doc, getDoc, updateDoc } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import {
  createInventoryVariant,
  createStockLog,
  findInventoryVariant,
  getProcessedByInfo,
} from '@/lib/server/inventory'
import { InventoryCondition, getStockStatus, normalizeInventoryCondition, toNumber } from '@/lib/server/salesInventoryMetrics'

interface RouteContext {
  params: Promise<{ id: string }>
}

interface AdjustPayload {
  action?: unknown
  quantity?: unknown
  targetCondition?: unknown
  remarks?: unknown
  processedBy?: unknown
}

export async function POST(req: Request, context: RouteContext) {
  try {
    const { id } = await context.params
    const body = (await req.json()) as AdjustPayload
    const action = typeof body.action === 'string' ? body.action.trim().toLowerCase() : ''
    const quantity = Math.floor(toNumber(body.quantity, Number.NaN))
    const remarks = typeof body.remarks === 'string' ? body.remarks.trim() : ''
    const processedBy = await getProcessedByInfo(body.processedBy)

    if (!id || !['add', 'deduct', 'transfer'].includes(action)) {
      return NextResponse.json({ error: 'Invalid stock adjustment request.' }, { status: 400 })
    }

    if (!Number.isFinite(quantity) || quantity <= 0) {
      return NextResponse.json({ error: 'Adjustment quantity must be greater than zero.' }, { status: 400 })
    }

    const snapshot = await getDoc(doc(db, 'inventory', id))
    if (!snapshot.exists()) {
      return NextResponse.json({ error: 'Item not found.' }, { status: 404 })
    }

    const data = snapshot.data() as Record<string, unknown>
    const sourceCondition = normalizeInventoryCondition(data.condition)
    const itemName = typeof data.name === 'string' ? data.name.trim() : ''
    const categoryId = typeof data.categoryId === 'string' ? data.categoryId.trim() : ''
    const categoryName =
      (typeof data.categoryName === 'string' && data.categoryName.trim()) ||
      (typeof data.category === 'string' && data.category.trim()) ||
      'Uncategorized'
    const price = Math.max(0, toNumber(data.price, 0))
    const minStock = Math.max(0, toNumber(data.minStock, 0))
    const currentStock = Math.max(0, toNumber(data.stock ?? data.quantity, 0))
    const currentReservedStock = Math.max(0, toNumber(data.reservedStock, 0))
    const availableStock = Math.max(0, currentStock - currentReservedStock)
    const sourceRef = doc(db, 'inventory', id)

    if (!itemName || !categoryId) {
      return NextResponse.json({ error: 'Inventory variant is missing required fields.' }, { status: 400 })
    }

    if (action === 'add') {
      const nextStock = currentStock + quantity
      await updateDoc(sourceRef, {
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

    if (quantity > availableStock) {
      return NextResponse.json(
        { error: 'Adjustment exceeds available stock. Reserved stock cannot be reduced.' },
        { status: 400 }
      )
    }

    if (action === 'deduct') {
      const nextStock = currentStock - quantity
      await updateDoc(sourceRef, {
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

    const targetCondition = normalizeInventoryCondition(body.targetCondition) as InventoryCondition
    if (targetCondition === sourceCondition) {
      return NextResponse.json({ error: 'Select a different condition for transfer.' }, { status: 400 })
    }

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

    await updateDoc(sourceRef, {
      stock: nextSourceStock,
      quantity: nextSourceStock,
      stockStatus: getStockStatus({ stock: nextSourceStock, minStock }),
      updatedAt: new Date().toISOString(),
    })

    if (targetVariant) {
      const nextTargetStock = targetVariant.stock + quantity
      await updateDoc(doc(db, 'inventory', targetVariant.id), {
        stock: nextTargetStock,
        quantity: nextTargetStock,
        price,
        minStock: targetVariant.minStock,
        stockStatus: getStockStatus({ stock: nextTargetStock, minStock: targetVariant.minStock }),
        updatedAt: new Date().toISOString(),
      })
    } else {
      const created = await createInventoryVariant({
        name: itemName,
        categoryId,
        categoryName,
        price,
        quantity,
        minStock,
        condition: targetCondition,
      })
      targetId = created.id
      targetStockBefore = 0
      targetReservedBefore = 0
      targetMinStock = minStock
    }

    const nextTargetStock = targetStockBefore + quantity

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

    await createStockLog({
      actionType: 'stock_transferred_in',
      itemId: targetId,
      itemName,
      condition: targetCondition,
      quantityBefore: targetStockBefore,
      quantityChanged: quantity,
      quantityAfter: nextTargetStock,
      stockBefore: targetStockBefore,
      stockAfter: nextTargetStock,
      reservedBefore: targetReservedBefore,
      reservedAfter: targetReservedBefore,
      user: processedBy,
      remarks: remarks || `Received stock from ${sourceCondition}.`,
      relatedId: id,
    })

    await updateDoc(doc(db, 'inventory', targetId), {
      stockStatus: getStockStatus({ stock: nextTargetStock, minStock: targetMinStock }),
      updatedAt: new Date().toISOString(),
    })

    return NextResponse.json({ success: true }, { status: 200 })
  } catch (error) {
    console.error('POST /api/inventory/[id]/adjust error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
