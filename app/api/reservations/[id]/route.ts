import { NextResponse } from 'next/server'
import { addDoc, collection, doc, getDoc, runTransaction, serverTimestamp } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { createStockLog, getProcessedByInfo } from '@/lib/server/inventory'
import { toNumber } from '@/lib/server/salesInventoryMetrics'
import { isCancellationReasonValid, SYSTEM_CANCELLATION_REASON, type CancellationReasonType } from '@/lib/cancellationReasons'

interface RouteContext {
  params: Promise<{ id: string }>
}

interface ReservationActionPayload {
  action?: unknown
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
  actionType: 'reservation_claim' | 'reservation_release'
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

export async function PATCH(req: Request, context: RouteContext) {
  try {
    const { id } = await context.params
    const body = (await req.json()) as ReservationActionPayload
    const action = typeof body.action === 'string' ? body.action.trim().toLowerCase() : ''
    const processedBy = await getProcessedByInfo(body.processedBy)

    // Parse and validate cancellation reason if provided
    const selectedReason = isCancellationReasonValid(body.cancellationReason)
      ? (body.cancellationReason as string)
      : null
    const cancellationReasonType = body.cancellationReasonType === 'manual' ? 'manual' : 'system'

    if (!id || !['complete', 'cancel', 'expire'].includes(action)) {
      return NextResponse.json({ error: 'Invalid reservation action.' }, { status: 400 })
    }

    // For manual cancellation, require a reason
    if (action === 'cancel' && !selectedReason) {
      return NextResponse.json(
        { error: 'Cancellation reason is required for manual cancellation.' },
        { status: 400 }
      )
    }

    const reservationRef = doc(db, 'reservations', id)
    const saleRef = doc(collection(db, 'sales'))
    const nowIso = new Date().toISOString()
    const pendingLogs: PendingStockLog[] = []
    let saleId: string | null = null

    await runTransaction(db, async (transaction) => {
      const reservationSnapshot = await transaction.get(reservationRef)
      if (!reservationSnapshot.exists()) {
        throw new Error('RESERVATION_NOT_FOUND')
      }

      const data = reservationSnapshot.data() as Record<string, unknown>
      const status = data.status as ReservationStatus
      if (status !== 'Active') {
        throw new Error('RESERVATION_NOT_ACTIVE')
      }

      const reservationItems = parseReservationItems(data.items)
      if (reservationItems.length === 0) {
        throw new Error('RESERVATION_ITEMS_MISSING')
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

        for (const item of reservationItems) {
          const inventoryRef = doc(db, 'inventory', item.id)
          const inventorySnapshot = await transaction.get(inventoryRef)
          if (!inventorySnapshot.exists()) {
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

          transaction.update(inventoryRef, {
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
            categoryId,
            categoryName,
            condition: item.condition,
          })
        }

        const totalAmount = saleItems.reduce((sum, item) => sum + item.quantity * item.price, 0)
        const categoryNames = Array.from(new Set(saleItems.map((item) => item.categoryName)))

        transaction.set(saleRef, {
          ...(saleItems.length === 1 ? { itemId: saleItems[0].itemId } : {}),
          id: saleRef.id,
          items: saleItems.map((item) => ({
            ...item,
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
          sourceReservationId: id,
          processedByName: processedBy.name,
          processedByEmail: processedBy.email ?? '',
          createdAt: serverTimestamp(),
          transactionDate: nowIso,
        })

        saleId = saleRef.id
        transaction.update(reservationRef, {
          status: 'Completed',
          completedAt: serverTimestamp(),
          completedByName: processedBy.name,
          updatedAt: nowIso,
        })

        return
      }

      for (const item of reservationItems) {
        const inventoryRef = doc(db, 'inventory', item.id)
        const inventorySnapshot = await transaction.get(inventoryRef)
        if (!inventorySnapshot.exists()) {
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

        transaction.update(inventoryRef, {
          reservedStock: nextReservedStock,
          updatedAt: nowIso,
        })

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
          action === 'expire' ? `Reservation expired - ${SYSTEM_CANCELLATION_REASON}` : `Reservation cancelled - ${cancellationDetails.cancellationReason}`

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

      transaction.update(reservationRef, {
        status: 'Cancelled',
        cancelledAt: serverTimestamp(),
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

      if (error.message === 'RESERVATION_NOT_ACTIVE') {
        return NextResponse.json({ error: 'Reservation is no longer active.' }, { status: 400 })
      }

      if (error.message === 'RESERVATION_ITEMS_MISSING') {
        return NextResponse.json({ error: 'Reservation has no items.' }, { status: 400 })
      }

      if (error.message === 'ITEM_NOT_FOUND') {
        return NextResponse.json({ error: 'One or more inventory items no longer exist.' }, { status: 404 })
      }

      if (error.message === 'INVALID_RESERVED_STOCK') {
        return NextResponse.json({ error: 'Reserved stock is no longer valid for this reservation.' }, { status: 400 })
      }
    }

    console.error('PATCH /api/reservations/[id] error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
