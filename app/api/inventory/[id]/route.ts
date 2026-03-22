import { NextResponse } from 'next/server'
import { deleteDoc, doc, getDoc, updateDoc } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { getStockStatus, normalizeInventoryCondition, toNumber } from '@/lib/server/salesInventoryMetrics'
import { assertAdminUser, createStockLog, findInventoryVariant, getProcessedByInfo } from '@/lib/server/inventory'

interface RouteContext {
  params: Promise<{ id: string }>
}

interface InventoryUpdatePayload {
  name?: unknown
  categoryId?: unknown
  categoryName?: unknown
  category?: unknown
  description?: unknown
  imageUrl?: unknown
  price?: unknown
  quantity?: unknown
  stock?: unknown
  minStock?: unknown
  status?: unknown
  processedBy?: unknown
  remarks?: unknown
}

export async function PUT(req: Request, context: RouteContext) {
  try {
    const { id } = await context.params
    if (!id) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }

    const snapshot = await getDoc(doc(db, 'inventory', id))
    if (!snapshot.exists()) {
      return NextResponse.json({ error: 'Item not found' }, { status: 404 })
    }

    const body = (await req.json()) as InventoryUpdatePayload
    const current = snapshot.data() as Record<string, unknown>
    const processedBy = await getProcessedByInfo(body.processedBy)
    const remarks = typeof body.remarks === 'string' ? body.remarks.trim() : ''

    const name =
      typeof body.name === 'string' && body.name.trim()
        ? body.name.trim()
        : typeof current.name === 'string'
          ? current.name.trim()
          : ''
    const categoryId =
      typeof body.categoryId === 'string' && body.categoryId.trim()
        ? body.categoryId.trim()
        : typeof current.categoryId === 'string'
          ? current.categoryId.trim()
          : ''
    const categoryName =
      typeof body.categoryName === 'string' && body.categoryName.trim()
        ? body.categoryName.trim()
        : typeof body.category === 'string' && body.category.trim()
          ? body.category.trim()
          : typeof current.categoryName === 'string' && current.categoryName.trim()
            ? current.categoryName.trim()
            : typeof current.category === 'string'
              ? current.category.trim()
              : ''

    const price = toNumber(
      body.price,
      typeof current.price === 'number' || typeof current.price === 'string' ? toNumber(current.price) : Number.NaN
    )
    const description =
      typeof body.description === 'string'
        ? body.description.trim()
        : typeof current.description === 'string'
          ? current.description.trim()
          : ''
    const imageUrl =
      typeof body.imageUrl === 'string'
        ? body.imageUrl.trim()
        : typeof current.imageUrl === 'string'
          ? current.imageUrl.trim()
          : ''
    const quantity = toNumber(
      current.stock ?? current.quantity,
      typeof current.stock === 'number' || typeof current.stock === 'string'
        ? toNumber(current.stock)
        : typeof current.quantity === 'number' || typeof current.quantity === 'string'
          ? toNumber(current.quantity)
          : Number.NaN
    )
    const minStock = toNumber(
      body.minStock,
      typeof current.minStock === 'number' || typeof current.minStock === 'string'
        ? toNumber(current.minStock)
        : Number.NaN
    )

    const currentCondition = normalizeInventoryCondition(current.status)
    const requestedCondition =
      body.status !== undefined ? normalizeInventoryCondition(body.status) : currentCondition
    const reservedStock = toNumber(
      current.reservedStock,
      typeof current.reservedStock === 'number' || typeof current.reservedStock === 'string'
        ? toNumber(current.reservedStock)
        : 0
    )

    if (!name || !categoryId || !categoryName) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }

    const requestedQuantity = body.stock ?? body.quantity
    if (requestedQuantity !== undefined && toNumber(requestedQuantity, quantity) !== quantity) {
      return NextResponse.json(
        { error: 'Use stock adjustment to add, deduct, or transfer stock.' },
        { status: 400 }
      )
    }

    if (
      !Number.isFinite(price) ||
      !Number.isFinite(quantity) ||
      !Number.isFinite(minStock) ||
      price <= 0 ||
      quantity < 0 ||
      minStock < 0 ||
      reservedStock < 0
    ) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }

    if (quantity < reservedStock) {
      return NextResponse.json({ error: 'Stock cannot be lower than reserved stock' }, { status: 400 })
    }

    const currentName = typeof current.name === 'string' ? current.name.trim() : ''
    const currentCategoryId = typeof current.categoryId === 'string' ? current.categoryId.trim() : ''
    const currentCategoryName =
      (typeof current.categoryName === 'string' && current.categoryName.trim()) ||
      (typeof current.category === 'string' && current.category.trim()) ||
      ''
    const currentPrice = toNumber(current.price, 0)
    const currentMinStock = toNumber(current.minStock, 0)

    if (requestedCondition !== currentCondition) {
      return NextResponse.json(
        { error: 'Condition is tracked as a separate variant. Use stock transfer to move quantity between conditions.' },
        { status: 400 }
      )
    }

    const duplicateVariant = await findInventoryVariant({ name, categoryId, condition: currentCondition })
    if (duplicateVariant && duplicateVariant.id !== id) {
      return NextResponse.json(
        { error: 'An inventory variant with the same item, category, and condition already exists.' },
        { status: 400 }
      )
    }

    const stockStatus = getStockStatus({ stock: quantity, minStock })
    const updatedAt = new Date().toISOString()

    await updateDoc(doc(db, 'inventory', id), {
      name,
      categoryId,
      categoryName,
      category: categoryName,
      price,
      quantity,
      stock: quantity,
      reservedStock,
      minStock,
      status: currentCondition,
      description,
      imageUrl,
      isDeleted: false,
      deletedAt: null,
      updatedAt,
    })

    await createStockLog({
      actionType: 'item_edited',
      itemId: id,
      itemName: name,
      condition: currentCondition,
      quantityBefore: quantity,
      quantityChanged: 0,
      quantityAfter: quantity,
      stockBefore: quantity,
      stockAfter: quantity,
      reservedBefore: reservedStock,
      reservedAfter: reservedStock,
      user: processedBy,
      previousValue:
        `Name: ${currentName} | Category: ${currentCategoryName || currentCategoryId} | Price: ${currentPrice} | Min Stock: ${currentMinStock} | Description: ${typeof current.description === 'string' ? current.description.trim() : ''} | Image: ${typeof current.imageUrl === 'string' ? current.imageUrl.trim() : ''}`,
      newValue:
        `Name: ${name} | Category: ${categoryName} | Price: ${price} | Min Stock: ${minStock} | Description: ${description} | Image: ${imageUrl}`,
      remarks:
        remarks || `Updated item details from ${currentName}/${currentCategoryId} to ${name}/${categoryId}.`,
    })

    return NextResponse.json(
      {
        data: {
          id,
          name,
          categoryId,
          categoryName,
          category: categoryName,
          price,
          quantity,
          stock: quantity,
          reservedStock,
          minStock,
          status: currentCondition,
          description,
          imageUrl,
          stockStatus,
          isDeleted: false,
          deletedAt: null,
          updatedAt,
        },
      },
      { status: 200 }
    )
  } catch (error) {
    console.error('PUT /api/inventory/[id] error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function DELETE(_: Request, context: RouteContext) {
  try {
    const { id } = await context.params
    if (!id) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }

    const body = (await _.json().catch(() => ({}))) as { processedBy?: unknown }
    await assertAdminUser(body.processedBy)

    const docRef = doc(db, 'inventory', id)
    const snapshot = await getDoc(docRef)
    if (!snapshot.exists()) {
      return NextResponse.json({ error: 'Item not found' }, { status: 404 })
    }

    const data = snapshot.data() as Record<string, unknown>
    const currentStock = toNumber(data.stock ?? data.quantity, 0)
    const currentReservedStock = toNumber(data.reservedStock, 0)

    if (currentStock > 0 || currentReservedStock > 0) {
      return NextResponse.json(
        { error: 'Cannot delete an item variant with remaining stock or reservations.' },
        { status: 400 }
      )
    }

    await updateDoc(docRef, {
      isDeleted: true,
      deletedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })

    await createStockLog({
      actionType: 'item_deleted',
      itemId: id,
      itemName: typeof data.name === 'string' ? data.name.trim() : 'Unnamed Item',
      condition: normalizeInventoryCondition(data.status),
      quantityBefore: currentStock,
      quantityChanged: 0,
      quantityAfter: currentStock,
      stockBefore: currentStock,
      stockAfter: currentStock,
      reservedBefore: currentReservedStock,
      reservedAfter: currentReservedStock,
      user: { name: 'System User' },
      remarks: 'Item moved to trash.',
    })
    return NextResponse.json({ success: true }, { status: 200 })
  } catch (error) {
    if (error instanceof Error && error.message === 'ADMIN_REQUIRED') {
      return NextResponse.json({ error: 'Admin access is required.' }, { status: 403 })
    }
    console.error(`DELETE /api/inventory/[id] error:`, error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function PATCH(req: Request, context: RouteContext) {
  try {
    const { id } = await context.params
    if (!id) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }

    const docRef = doc(db, 'inventory', id)
    const snapshot = await getDoc(docRef)
    if (!snapshot.exists()) {
      return NextResponse.json({ error: 'Item not found' }, { status: 404 })
    }

    const body = (await req.json()) as { action?: unknown }
    const action = typeof body.action === 'string' ? body.action : ''
    const processedBy = await assertAdminUser((body as Record<string, unknown>).processedBy)
    const snapshotData = snapshot.data() as Record<string, unknown>
    const itemName = typeof snapshotData.name === 'string' ? snapshotData.name.trim() : 'Unnamed Item'
    const condition = normalizeInventoryCondition(snapshotData.status)
    const currentStock = toNumber(snapshotData.stock ?? snapshotData.quantity, 0)
    const currentReservedStock = toNumber(snapshotData.reservedStock, 0)

    if (action === 'restore') {
      await updateDoc(docRef, {
        isDeleted: false,
        deletedAt: null,
        updatedAt: new Date().toISOString(),
      })
      await createStockLog({
        actionType: 'item_restored',
        itemId: id,
        itemName,
        condition,
        quantityBefore: currentStock,
        quantityChanged: 0,
        quantityAfter: currentStock,
        stockBefore: currentStock,
        stockAfter: currentStock,
        reservedBefore: currentReservedStock,
        reservedAfter: currentReservedStock,
        user: processedBy,
        remarks: 'Item restored from trash.',
      })
      return NextResponse.json({ success: true }, { status: 200 })
    }

    if (action === 'permanent-delete') {
      await deleteDoc(docRef)
      await createStockLog({
        actionType: 'item_deleted_permanently',
        itemId: id,
        itemName,
        condition,
        quantityBefore: currentStock,
        quantityChanged: 0,
        quantityAfter: currentStock,
        stockBefore: currentStock,
        stockAfter: currentStock,
        reservedBefore: currentReservedStock,
        reservedAfter: currentReservedStock,
        user: processedBy,
        remarks: 'Item deleted permanently from trash.',
      })
      return NextResponse.json({ success: true }, { status: 200 })
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  } catch (error) {
    if (error instanceof Error && error.message === 'ADMIN_REQUIRED') {
      return NextResponse.json({ error: 'Admin access is required.' }, { status: 403 })
    }
    console.error(`PATCH /api/inventory/[id] error:`, error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
