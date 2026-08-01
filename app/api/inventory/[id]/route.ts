// Inventory item detail API - PUT to edit, DELETE to move to trash, PATCH to restore/permanently delete
import { NextResponse } from 'next/server'
import { deleteDoc, doc, getDoc, updateDoc } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { getStockStatus, normalizeInventoryCondition, toNumber } from '@/lib/server/salesInventoryMetrics'
import { assertAdminUser, createStockLog, findInventoryVariant, getProcessedByInfo } from '@/lib/server/inventory'
import { guardProcessedBy } from '@/lib/server/authorize'

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
  condition?: unknown
  containerId?: unknown
  processedBy?: unknown
  remarks?: unknown
}

// PUT /api/inventory/[id] - Update item details (name, price, category, etc.)
export async function PUT(req: Request, context: RouteContext) {
  try {
    // Step 1: Get item ID and fetch current item
    const { id } = await context.params
    if (!id) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }

    const snapshot = await getDoc(doc(db, 'inventory', id))
    if (!snapshot.exists()) {
      return NextResponse.json({ error: 'Item not found' }, { status: 404 })
    }

    // Step 2: Parse request and get user info
    const body = (await req.json()) as InventoryUpdatePayload
    const current = snapshot.data() as Record<string, unknown>

    // Editing an item is a privileged action - check before reading further.
    const denied = await guardProcessedBy(body.processedBy, 'canManageInventory')
    if (denied) return denied

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

    // containerId: explicit null clears it, string sets it, undefined preserves existing
    const containerId =
      body.containerId === null
        ? null
        : typeof body.containerId === 'string' && body.containerId.trim()
          ? body.containerId.trim()
          : typeof current.containerId === 'string' && current.containerId.trim()
            ? current.containerId.trim()
            : null

    const currentCondition = normalizeInventoryCondition(current.condition)
    const requestedCondition =
      body.condition !== undefined ? normalizeInventoryCondition(body.condition) : currentCondition
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
      condition: currentCondition,
      description,
      imageUrl,
      containerId,
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

// DELETE /api/inventory/[id] - Move item to trash (soft delete, requires zero stock)
export async function DELETE(_: Request, context: RouteContext) {
  try {
    // Step 1: Parse ID and verify admin access
    const { id } = await context.params
    if (!id) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }

    const body = (await _.json().catch(() => ({}))) as { processedBy?: unknown }
    await assertAdminUser(body.processedBy)

    // Step 2: Get current item data
    const docRef = doc(db, 'inventory', id)
    const snapshot = await getDoc(docRef)
    if (!snapshot.exists()) {
      return NextResponse.json({ error: 'Item not found' }, { status: 404 })
    }

    const data = snapshot.data() as Record<string, unknown>
    const currentStock = toNumber(data.stock ?? data.quantity, 0)
    const currentReservedStock = toNumber(data.reservedStock, 0)

    // Step 3: Check item has zero stock and zero reservations (can't delete if stock exists)
    if (currentStock > 0 || currentReservedStock > 0) {
      return NextResponse.json(
        { error: 'This item cannot be permanently deleted because it still contains inventory or transaction history. You may void the item instead.' },
        { status: 400 }
      )
    }

    // Step 4: Mark as deleted (soft delete, can be restored)
    await updateDoc(docRef, {
      isDeleted: true,
      deletedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })

    // Step 5: Log the deletion
    await createStockLog({
      actionType: 'item_deleted',
      itemId: id,
      itemName: typeof data.name === 'string' ? data.name.trim() : 'Unnamed Item',
      condition: normalizeInventoryCondition(data.condition),
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

// PATCH /api/inventory/[id] - Restore from trash or permanently delete
export async function PATCH(req: Request, context: RouteContext) {
  try {
    // Step 1: Get item ID and verify admin access
    const { id } = await context.params
    if (!id) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }

    const docRef = doc(db, 'inventory', id)
    const snapshot = await getDoc(docRef)
    if (!snapshot.exists()) {
      return NextResponse.json({ error: 'Item not found' }, { status: 404 })
    }

    // Step 2: Parse request and get admin user
    const body = (await req.json()) as { action?: unknown }
    const action = typeof body.action === 'string' ? body.action : ''
    const processedBy = await assertAdminUser((body as Record<string, unknown>).processedBy)
    const snapshotData = snapshot.data() as Record<string, unknown>
    const itemName = typeof snapshotData.name === 'string' ? snapshotData.name.trim() : 'Unnamed Item'
    const condition = normalizeInventoryCondition(snapshotData.condition)
    const currentStock = toNumber(snapshotData.stock ?? snapshotData.quantity, 0)
    const currentReservedStock = toNumber(snapshotData.reservedStock, 0)

    // Step 3: Handle restore action (move back from trash)
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


    if (action === 'void') {
      const voidReason = typeof (body as Record<string, unknown>).voidReason === 'string'
        ? ((body as Record<string, unknown>).voidReason as string).trim()
        : ''
      if (!voidReason) {
        return NextResponse.json({ error: 'A void reason is required.' }, { status: 400 })
      }

      // Parse voidQuantity — defaults to full stock if not provided
      const rawVoidQty = (body as Record<string, unknown>).voidQuantity
      const voidQuantity = typeof rawVoidQty === 'number' && rawVoidQty > 0
        ? Math.floor(rawVoidQty)
        : currentStock
      if (voidQuantity > currentStock) {
        return NextResponse.json(
          { error: `Cannot void ${voidQuantity} units — only ${currentStock} in stock.` },
          { status: 400 }
        )
      }

      const isFullVoid = voidQuantity >= currentStock
      // Stored alongside stock so the cached status never disagrees with the
      // quantity, matching what the stock-adjustment route does.
      const voidMinStock = toNumber(snapshotData.minStock, 0)

      // Running total of units written off this item, across every void.
      // `isVoided` still means "entirely written off" and is what sales and
      // reservations check. `voidedUnits` is the write-off HISTORY, which is
      // what lets a partially voided item still appear under Voided even though
      // it remains active and sellable.
      const previousVoidedUnits = toNumber(snapshotData.voidedUnits, 0)
      const nextVoidedUnits = previousVoidedUnits + voidQuantity

      // Check for active reservations (only block full voids)
      if (isFullVoid) {
        const { collection: fsCollection, getDocs, query: fsQuery, where } = await import('firebase/firestore')
        const activeResQuery = fsQuery(
          fsCollection(db, 'reservations'),
          where('status', '==', 'active')
        )
        const activeResDocs = await getDocs(activeResQuery)
        const hasActiveReservation = activeResDocs.docs.some((resDoc) => {
          const resData = resDoc.data() as Record<string, unknown>
          const items = Array.isArray(resData.items) ? resData.items : []
          return items.some((item: Record<string, unknown>) => item.itemId === id || item.id === id)
        })
        if (hasActiveReservation) {
          return NextResponse.json(
            { error: 'This item has an active reservation and cannot be fully voided. Please cancel or complete the reservation first.' },
            { status: 400 }
          )
        }
      }

      const newStock = currentStock - voidQuantity

      if (isFullVoid) {
        // Full void: mark the item voided and write the stock off.
        //
        // BOTH `stock` and `quantity` must be zeroed. Item documents carry both
        // fields, and every reader resolves them as `stock ?? quantity` - so
        // clearing only `quantity` leaves the old figure showing everywhere.
        //
        // `voidedQuantity` remembers what was written off, so restoring the
        // item can hand the same amount back instead of making the user re-key
        // it. See the 'unvoid' branch below.
        await updateDoc(docRef, {
          isVoided: true,
          voidedAt: new Date().toISOString(),
          voidedBy: processedBy.name ?? processedBy.email ?? 'Admin',
          voidReason,
          voidedQuantity: voidQuantity,
          voidedUnits: nextVoidedUnits,
          stock: 0,
          quantity: 0,
          stockStatus: getStockStatus({ stock: 0, minStock: voidMinStock }),
          updatedAt: new Date().toISOString(),
        })
        await createStockLog({
          actionType: 'item_voided',
          itemId: id,
          itemName,
          condition,
          quantityBefore: currentStock,
          quantityChanged: -voidQuantity,
          quantityAfter: 0,
          stockBefore: currentStock,
          stockAfter: 0,
          reservedBefore: currentReservedStock,
          reservedAfter: currentReservedStock,
          user: processedBy,
          remarks: `Item fully voided (${voidQuantity} unit${voidQuantity !== 1 ? 's' : ''}). Reason: ${voidReason}`,
        })
      } else {
        // Partial void: write off some units, the item stays active and
        // sellable with what remains.
        //
        // As in the full-void branch above, BOTH `stock` and `quantity` must be
        // written. Readers resolve them as `stock ?? quantity`, so updating
        // only `quantity` leaves the original figure on screen and the units
        // are never actually removed.
        await updateDoc(docRef, {
          stock: newStock,
          quantity: newStock,
          stockStatus: getStockStatus({ stock: newStock, minStock: voidMinStock }),
          // Recorded so the write-off is visible on the Voided tab. The item is
          // deliberately NOT flagged isVoided - it still has sellable stock.
          voidedUnits: nextVoidedUnits,
          voidReason,
          voidedAt: new Date().toISOString(),
          voidedBy: processedBy.name ?? processedBy.email ?? 'Admin',
          updatedAt: new Date().toISOString(),
        })
        await createStockLog({
          actionType: 'item_voided',
          itemId: id,
          itemName,
          condition,
          quantityBefore: currentStock,
          quantityChanged: -voidQuantity,
          quantityAfter: newStock,
          stockBefore: currentStock,
          stockAfter: newStock,
          reservedBefore: currentReservedStock,
          reservedAfter: currentReservedStock,
          user: processedBy,
          remarks: `Partial void: ${voidQuantity} of ${currentStock} unit${currentStock !== 1 ? 's' : ''} removed. Reason: ${voidReason}`,
        })
      }

      return NextResponse.json({ success: true, isFullVoid, newStock }, { status: 200 })
    }

    if (action === 'unvoid') {
      // Restoring a voided item gives its stock back.
      //
      // In practice the restore button is used to undo a mistake - a duplicate
      // entry or a wrong encoding - not to bring damaged goods back. Making the
      // user re-key the quantity would also muddy the audit trail: a void of -5
      // followed by a manual add of +5 reads as real stock movement, whereas a
      // void followed by an un-void reads as the correction it actually was.
      //
      // The caller may restore ALL written-off units or only some of them - a
      // shipment of 8 damaged units where 3 turned out to be fine, for example.
      // Omitting restoreQuantity restores everything.
      //
      // `voidedUnits` is the ceiling: you can never restore more than was
      // written off. It falls back to `voidedQuantity` for items voided before
      // the running total existed, and to 0 for older records still - those
      // simply come back with no stock, which is safe.
      const maxRestorable = Math.max(
        toNumber(snapshotData.voidedUnits, 0),
        toNumber(snapshotData.voidedQuantity, 0)
      )

      const rawRestoreQty = (body as Record<string, unknown>).restoreQuantity
      const restoreQuantity =
        typeof rawRestoreQty === 'number' && rawRestoreQty >= 0
          ? Math.floor(rawRestoreQty)
          : maxRestorable

      if (restoreQuantity > maxRestorable) {
        return NextResponse.json(
          {
            error: `Cannot restore ${restoreQuantity} units — only ${maxRestorable} ${
              maxRestorable === 1 ? 'was' : 'were'
            } voided.`,
          },
          { status: 400 }
        )
      }

      const restoredStock = currentStock + restoreQuantity

      // Units left written off stay on record, so an item that is only partly
      // restored still appears on the Voided tab with the remainder.
      const remainingVoidedUnits = Math.max(0, maxRestorable - restoreQuantity)

      await updateDoc(docRef, {
        isVoided: false,
        voidedAt: remainingVoidedUnits > 0 ? snapshotData.voidedAt ?? null : null,
        voidedBy: remainingVoidedUnits > 0 ? snapshotData.voidedBy ?? null : null,
        voidReason: remainingVoidedUnits > 0 ? snapshotData.voidReason ?? null : null,
        voidedQuantity: null,
        voidedUnits: remainingVoidedUnits > 0 ? remainingVoidedUnits : null,
        stock: restoredStock,
        quantity: restoredStock,
        stockStatus: getStockStatus({
          stock: restoredStock,
          minStock: toNumber(snapshotData.minStock, 0),
        }),
        updatedAt: new Date().toISOString(),
      })
      await createStockLog({
        actionType: 'item_unvoided',
        itemId: id,
        itemName,
        condition,
        quantityBefore: currentStock,
        quantityChanged: restoreQuantity,
        quantityAfter: restoredStock,
        stockBefore: currentStock,
        stockAfter: restoredStock,
        reservedBefore: currentReservedStock,
        reservedAfter: currentReservedStock,
        user: processedBy,
        remarks: restoreQuantity > 0
          ? `Restored ${restoreQuantity} of ${maxRestorable} voided unit${maxRestorable !== 1 ? 's' : ''}.` +
            (remainingVoidedUnits > 0
              ? ` ${remainingVoidedUnits} unit${remainingVoidedUnits !== 1 ? 's' : ''} remain voided.`
              : ' Item fully restored.')
          : 'Item restored from voided state. No stock was reinstated.',
      })
      return NextResponse.json(
        { success: true, restoredStock, restoreQuantity, remainingVoidedUnits },
        { status: 200 }
      )
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
