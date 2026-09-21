// Reservation detail API - PATCH to update reservation status (complete/cancel/expire)
import { NextResponse } from 'next/server'
import { getReservationDays, getStoreSettings } from '@/lib/server/storeSettings'
import { allocateTransactionNumber } from '@/lib/server/transactionNumbers'
import { FieldValue, type DocumentReference } from 'firebase-admin/firestore'
import { getAdminDb } from '@/lib/firebaseAdmin'
import { createStockLog, getProcessedByInfo } from '@/lib/server/inventory'
import { toNumber } from '@/lib/server/salesInventoryMetrics'
import { isCancellationReasonValid, SYSTEM_CANCELLATION_REASON, type CancellationReasonType } from '@/lib/reservations/cancellationReasons'
import { guardRequest } from '@/lib/server/authorize'

interface RouteContext {
  params: Promise<{ id: string }>
}

interface ReservationActionPayload {
  action?: unknown // 'complete', 'cancel', 'expire'
  processedBy?: unknown
  cancellationReason?: unknown
  cancellationReasonType?: unknown
  customCancellationReason?: unknown
}

type ReservationStatus = 'Active' | 'Completed' | 'Cancelled' | 'Expired'

interface ReservationItemRecord {
  id: string
  name: string
  quantity: number
  price: number
  condition: 'New' | 'Refurbished'
}

interface PendingStockLog {
  actionType: 'reservation_claim' | 'reservation_release' | 'reservation_deduction'
  itemId: string
  itemName: string
  condition: 'New' | 'Refurbished'
  quantityBefore: number
  quantityChanged: number
  quantityAfter: number
  stockBefore: number
  stockAfter: number
  reservedBefore: number
  reservedAfter: number
  remarks: string
}

const parseReservationItems = (items: unknown): ReservationItemRecord[] => {
  if (!Array.isArray(items)) return []

  return items
    .map((item) => {
      const record = item as Record<string, unknown>
      const id = typeof record.id === 'string' ? record.id.trim() : ''
      const name = typeof record.name === 'string' ? record.name.trim() : ''
      const quantity = Math.max(0, Math.floor(toNumber(record.quantity, 0)))
      const price = Math.max(0, toNumber(record.price, 0))
      const condition = record.condition === 'Refurbished' ? 'Refurbished' : 'New'

      if (!id || !name || quantity <= 0) return null
      return { id, name, quantity, price, condition }
    })
    .filter((item): item is ReservationItemRecord => item !== null)
}

// PATCH /api/reservations/[id] - Update reservation status (complete/cancel/expire)
export async function PATCH(req: Request, context: RouteContext) {
  try {
    // Step 1: Parse request
    const { id } = await context.params
    const body = (await req.json()) as ReservationActionPayload
    const action = typeof body.action === 'string' ? body.action.trim().toLowerCase() : ''

    // Completing, cancelling or expiring a reservation releases or consumes
    // reserved stock, so the same permission applies as creating one.
    const denied = await guardRequest(req, 'canManageReservations')
    if (denied) return denied

    const processedBy = await getProcessedByInfo(body.processedBy)

    // Step 2: Validate cancellation reason if cancelling
    const selectedReason = isCancellationReasonValid(body.cancellationReason)
      ? (body.cancellationReason as string)
      : null
    const cancellationReasonType = body.cancellationReasonType === 'manual' ? 'manual' : 'system'

    // Step 3: Validate action and ID
    if (!id || !['complete', 'cancel', 'expire', 'extend', 'reinstate'].includes(action)) {
      return NextResponse.json({ error: 'Invalid reservation action.' }, { status: 400 })
    }

    // Step 4: For manual cancellation, require a reason
    if (action === 'cancel' && !selectedReason) {
      return NextResponse.json(
        { error: 'Cancellation reason is required for manual cancellation.' },
        { status: 400 }
      )
    }

    // Extending or reinstating restarts the hold, using the period the shop set
    const holdDays = await getReservationDays()

    const adminDb = getAdminDb()
    const reservationRef = adminDb.collection('reservations').doc(id)
    const saleRef = adminDb.collection('sales').doc()
    const nowIso = new Date().toISOString()
    const pendingLogs: PendingStockLog[] = []
    let saleId: string | null = null

    // A claimed reservation becomes a real sale, so it needs everything a
    // counter sale gets: a receipt number, and the warranty window promised on
    // the day it was paid for. Both are resolved BEFORE the transaction opens -
    // allocateTransactionNumber runs its own transaction and cannot be nested,
    // and getStoreSettings is a read that must not sit inside one either.
    const saleNumber = action === 'complete' ? await allocateTransactionNumber('sale', nowIso) : null
    const saleWarrantyDays = action === 'complete' ? (await getStoreSettings()).warrantyDays : null

    await adminDb.runTransaction(async (transaction) => {
      const reservationSnapshot = await transaction.get(reservationRef)
      if (!reservationSnapshot.exists) {
        throw new Error('RESERVATION_NOT_FOUND')
      }

      const data = reservationSnapshot.data() as Record<string, unknown>
      const status = data.status as ReservationStatus

      // reinstate revives a lapsed hold; everything else needs a live one
      if (action === 'reinstate') {
        if (status !== 'Expired' && status !== 'Cancelled') {
          throw new Error('RESERVATION_NOT_LAPSED')
        }
      } else if (status !== 'Active') {
        throw new Error('RESERVATION_NOT_ACTIVE')
      }

      const reservationItems = parseReservationItems(data.items)
      if (reservationItems.length === 0) {
        throw new Error('RESERVATION_ITEMS_MISSING')
      }

      // ── Extend: push a live hold further out ──
      if (action === 'extend') {
        const until = new Date(Date.now() + holdDays * 24 * 60 * 60 * 1000)
        transaction.update(reservationRef, {
          expiresAt: until.toISOString(),
          updatedAt: nowIso,
        })
        return
      }

      // ── Reinstate: the customer arrived after the hold lapsed ──
      //
      // The stock went back on sale when the hold expired, so it may since have
      // been sold. Each line is re-checked against what is actually available
      // and the hold is only revived if every item can still be covered.
      if (action === 'reinstate') {
        // Firestore requires EVERY read in a transaction to happen before ANY
        // write. Reading and updating inside one loop works for a single-line
        // reservation and throws on the second item, so the two phases are kept
        // apart: collect every line first, then write.
        const reinstateWrites: Array<{
          ref: DocumentReference
          item: ReservationItemRecord
          currentStock: number
          currentReserved: number
          available: number
        }> = []

        // ── Phase 1: read and validate every line ──
        for (const item of reservationItems) {
          const inventoryRef = adminDb.collection('inventory').doc(item.id)
          const inventorySnapshot = await transaction.get(inventoryRef)
          if (!inventorySnapshot.exists) {
            throw new Error(`REINSTATE_UNAVAILABLE:${item.name}`)
          }

          const inventoryData = inventorySnapshot.data() as Record<string, unknown>
          if (inventoryData.isVoided === true || inventoryData.isDeleted === true) {
            throw new Error(`REINSTATE_UNAVAILABLE:${item.name}`)
          }

          const currentStock = Math.max(0, toNumber(inventoryData.stock ?? inventoryData.quantity, 0))
          const currentReserved = Math.max(0, toNumber(inventoryData.reservedStock, 0))
          const available = Math.max(0, currentStock - currentReserved)

          if (available < item.quantity) {
            throw new Error(`REINSTATE_UNAVAILABLE:${item.name}`)
          }

          reinstateWrites.push({ ref: inventoryRef, item, currentStock, currentReserved, available })
        }

        // ── Phase 2: write ──
        for (const entry of reinstateWrites) {
          const { ref, item, currentStock, currentReserved, available } = entry

          transaction.update(ref, {
            reservedStock: currentReserved + item.quantity,
            updatedAt: nowIso,
          })

          pendingLogs.push({
            actionType: 'reservation_deduction',
            itemId: item.id,
            itemName: item.name,
            condition: item.condition,
            quantityBefore: available,
            quantityChanged: item.quantity,
            quantityAfter: available - item.quantity,
            stockBefore: currentStock,
            stockAfter: currentStock,
            reservedBefore: currentReserved,
            reservedAfter: currentReserved + item.quantity,
            remarks: 'Reservation reinstated - customer returned after the hold lapsed.',
          })
        }

        const until = new Date(Date.now() + holdDays * 24 * 60 * 60 * 1000)
        transaction.update(reservationRef, {
          status: 'Active',
          expiresAt: until.toISOString(),
          cancellationReason: '',
          cancellationReasonType: '',
          cancelledByName: '',
          cancelledAt: null,
          reinstatedAt: nowIso,
          reinstatedBy: processedBy.name,
          updatedAt: nowIso,
        })
        return
      }

      if (action === 'complete') {
        const saleItems: Array<{
          itemId: string
          name: string
          quantity: number
          price: number
          categoryId: string
          categoryName: string
          condition: string
        }> = []

        // Same two-phase split as reinstate: every read first, then the writes.
        // Firestore rejects a read that follows a write in the same transaction,
        // so the interleaved version only ever worked for one-line reservations.
        const claimWrites: Array<{
          ref: DocumentReference
          item: ReservationItemRecord
          currentStock: number
          currentReservedStock: number
          nextStock: number
          nextReservedStock: number
          categoryId: string
          categoryName: string
        }> = []

        // ── Phase 1: read and validate every line ──
        for (const item of reservationItems) {
          const inventoryRef = adminDb.collection('inventory').doc(item.id)
          const inventorySnapshot = await transaction.get(inventoryRef)
          if (!inventorySnapshot.exists) {
            throw new Error('ITEM_NOT_FOUND')
          }

          const inventoryData = inventorySnapshot.data() as Record<string, unknown>
          const currentStock = Math.max(0, toNumber(inventoryData.stock ?? inventoryData.quantity, 0))
          const currentReservedStock = Math.max(0, toNumber(inventoryData.reservedStock, 0))
          const nextStock = currentStock - item.quantity
          const nextReservedStock = currentReservedStock - item.quantity

          if (item.quantity > currentReservedStock || nextStock < 0 || nextReservedStock < 0) {
            throw new Error('INVALID_RESERVED_STOCK')
          }

          const categoryName =
            (typeof inventoryData.categoryName === 'string' && inventoryData.categoryName.trim()) ||
            (typeof inventoryData.category === 'string' && inventoryData.category.trim()) ||
            'Uncategorized'
          const categoryId =
            typeof inventoryData.categoryId === 'string' && inventoryData.categoryId.trim()
              ? inventoryData.categoryId.trim()
              : ''

          claimWrites.push({
            ref: inventoryRef,
            item,
            currentStock,
            currentReservedStock,
            nextStock,
            nextReservedStock,
            categoryId,
            categoryName,
          })
        }

        // ── Phase 2: write ──
        for (const entry of claimWrites) {
          const { ref, item, currentStock, currentReservedStock, nextStock, nextReservedStock } = entry

          transaction.update(ref, {
            stock: nextStock,
            quantity: nextStock,
            reservedStock: nextReservedStock,
            updatedAt: nowIso,
          })

          pendingLogs.push({
            actionType: 'reservation_claim',
            itemId: item.id,
            itemName: item.name,
            condition: item.condition,
            quantityBefore: currentStock,
            quantityChanged: item.quantity * -1,
            quantityAfter: nextStock,
            stockBefore: currentStock,
            stockAfter: nextStock,
            reservedBefore: currentReservedStock,
            reservedAfter: nextReservedStock,
            remarks: `Reservation ${id} claimed.`,
          })

          saleItems.push({
            itemId: item.id,
            name: item.name,
            quantity: item.quantity,
            price: item.price,
            categoryId: entry.categoryId,
            categoryName: entry.categoryName,
            condition: item.condition,
          })
        }

        const totalAmount = saleItems.reduce((sum, item) => sum + item.quantity * item.price, 0)
        const categoryNames = Array.from(new Set(saleItems.map((item) => item.categoryName)))

        transaction.set(saleRef, {
          ...(saleItems.length === 1 ? { itemId: saleItems[0].itemId } : {}),
          id: saleRef.id,
          // Receipt identity - without these the sale shows its raw document id
          // in the sales list and cannot be found by receipt search.
          receiptNumber: saleNumber!.value,
          searchableNumber: saleNumber!.value,
          transactionType: 'sale',
          dateKey: saleNumber!.dateKey,
          sequenceNumber: saleNumber!.sequenceNumber,
          customerSearchEmail:
            typeof data.customerEmail === 'string' ? data.customerEmail.toLowerCase() : '',
          items: saleItems.map((item) => ({
            ...item,
            warrantyDays: saleWarrantyDays!,
            status: 'completed',
          })),
          categoryName: categoryNames.join(', '),
          category: categoryNames.join(', '),
          customer: typeof data.customerName === 'string' ? data.customerName : data.customer,
          customerName: typeof data.customerName === 'string' ? data.customerName : data.customer,
          customerEmail: typeof data.customerEmail === 'string' ? data.customerEmail : '',
          customerContactNumber: typeof data.customerContactNumber === 'string' ? data.customerContactNumber : '',
          totalAmount,
          quantity: saleItems.reduce((sum, item) => sum + item.quantity, 0),
          total: totalAmount,
          amount: totalAmount,
          status: 'Completed',
          // Snapshot of the store policy on the day the reservation was paid,
          // so a later policy change cannot move this customer's refund window.
          warrantyDays: saleWarrantyDays!,
          sourceReservationId: id,
          processedByName: processedBy.name,
          processedByEmail: processedBy.email ?? '',
          createdAt: FieldValue.serverTimestamp(),
          transactionDate: nowIso,
        })

        saleId = saleRef.id
        transaction.update(reservationRef, {
          status: 'Completed',
          completedAt: FieldValue.serverTimestamp(),
          completedByName: processedBy.name,
          updatedAt: nowIso,
        })

        return
      }

      // ── Cancel / expire: release the held units back to sellable stock ──
      //
      // Two-phase, for the same Firestore reason as the branches above: every
      // read before any write.
      const releaseWrites: Array<{
        ref: DocumentReference
        item: ReservationItemRecord
        currentStock: number
        currentReservedStock: number
        availableBefore: number
        nextReservedStock: number
      }> = []

      // ── Phase 1: read and validate every line ──
      for (const item of reservationItems) {
        const inventoryRef = adminDb.collection('inventory').doc(item.id)
        const inventorySnapshot = await transaction.get(inventoryRef)
        if (!inventorySnapshot.exists) {
          throw new Error('ITEM_NOT_FOUND')
        }

        const inventoryData = inventorySnapshot.data() as Record<string, unknown>
        const currentStock = Math.max(0, toNumber(inventoryData.stock ?? inventoryData.quantity, 0))
        const currentReservedStock = Math.max(0, toNumber(inventoryData.reservedStock, 0))
        const availableBefore = Math.max(0, currentStock - currentReservedStock)
        const nextReservedStock = currentReservedStock - item.quantity

        if (item.quantity > currentReservedStock || nextReservedStock < 0) {
          throw new Error('INVALID_RESERVED_STOCK')
        }

        releaseWrites.push({
          ref: inventoryRef,
          item,
          currentStock,
          currentReservedStock,
          availableBefore,
          nextReservedStock,
        })
      }

      const cancellationDetails =
        action === 'expire'
          ? {
              cancellationReason: SYSTEM_CANCELLATION_REASON,
              cancellationReasonType: 'system' as CancellationReasonType,
              cancelledBy: 'System',
            }
          : {
              cancellationReason:
                selectedReason === 'Other'
                  ? typeof body.customCancellationReason === 'string'
                    ? body.customCancellationReason.trim()
                    : selectedReason
                  : selectedReason,
              cancellationReasonType: 'manual' as CancellationReasonType,
              cancelledBy: processedBy.name,
            }

      const reasonSuffix =
        action === 'expire'
          ? `Reservation expired - ${SYSTEM_CANCELLATION_REASON}`
          : `Reservation cancelled - ${cancellationDetails.cancellationReason}`

      // ── Phase 2: write ──
      for (const entry of releaseWrites) {
        const { ref, item, currentStock, currentReservedStock, availableBefore, nextReservedStock } = entry

        transaction.update(ref, {
          reservedStock: nextReservedStock,
          updatedAt: nowIso,
        })

        pendingLogs.push({
          actionType: 'reservation_release',
          itemId: item.id,
          itemName: item.name,
          condition: item.condition,
          quantityBefore: availableBefore,
          quantityChanged: item.quantity,
          quantityAfter: availableBefore + item.quantity,
          stockBefore: currentStock,
          stockAfter: currentStock,
          reservedBefore: currentReservedStock,
          reservedAfter: nextReservedStock,
          remarks: reasonSuffix,
        })
      }

      // An expired hold is not a cancelled one. Both branches used to write
      // 'Cancelled', which made 'Expired' a status the interface could render
      // but the system could never produce - the Expired tally on Reservations
      // and the Expired slice on the Analytics chart both sat permanently at
      // zero, and a hold the shop released on time looked like one a staff
      // member had cancelled.
      transaction.update(reservationRef, {
        status: action === 'expire' ? 'Expired' : 'Cancelled',
        cancelledAt: FieldValue.serverTimestamp(),
        cancelledByName: cancellationDetails.cancelledBy,
        cancellationReason: cancellationDetails.cancellationReason,
        cancellationReasonType: cancellationDetails.cancellationReasonType,
        updatedAt: nowIso,
      })
    })

    await Promise.all(
      pendingLogs.map((log) =>
        createStockLog({
          ...log,
          user: processedBy,
          relatedId: id,
        })
      )
    )

    return NextResponse.json(
      {
        success: true,
        saleId,
      },
      { status: 200 }
    )
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === 'RESERVATION_NOT_FOUND') {
        return NextResponse.json({ error: 'Reservation not found.' }, { status: 404 })
      }

      if (error.message.startsWith('REINSTATE_UNAVAILABLE:')) {
        const itemName = error.message.split(':').slice(1).join(':')
        return NextResponse.json(
          {
            error: `${itemName} is no longer available in the quantity reserved, so this hold cannot be reinstated. It was released when the hold lapsed and has since been sold or written off.`,
          },
          { status: 409 }
        )
      }

      if (error.message === 'RESERVATION_NOT_LAPSED') {
        return NextResponse.json(
          { error: 'Only a lapsed or cancelled reservation can be reinstated.' },
          { status: 400 }
        )
      }

      if (error.message === 'RESERVATION_NOT_ACTIVE') {
        return NextResponse.json({ error: 'Reservation is no longer active.' }, { status: 400 })
      }

      if (error.message === 'RESERVATION_ITEMS_MISSING') {
        return NextResponse.json({ error: 'Reservation has no items.' }, { status: 400 })
      }

      if (error.message === 'ITEM_NOT_FOUND') {
        return NextResponse.json({ error: 'One or more inventory items no longer exist.' }, { status: 404 })
      }

      if (error.message === 'INSUFFICIENT_STOCK') {
        return NextResponse.json({ error: 'Insufficient stock to complete reservation.' }, { status: 400 })
      }
    }

    console.error('[PATCH /api/reservations/[id]]', error)
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
  }
}
