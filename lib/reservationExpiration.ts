import { collection, doc, getDocs, query, runTransaction, serverTimestamp, where } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { createStockLog, getProcessedByInfo } from '@/lib/server/inventory'
import { toDate, toNumber } from '@/lib/server/salesInventoryMetrics'
import { SYSTEM_CANCELLATION_REASON } from '@/lib/cancellationReasons'

interface ReservationItemRecord {
  id: string
  name: string
  quantity: number
  price: number
  condition: 'New' | 'Refurbished'
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

/**
 * Automatically expire all reservations that have passed their expiration date.
 * This function should be called periodically or on page load.
 * @returns Promise<number> The number of reservations that were expired
 */
export async function expireReservations(): Promise<number> {
  try {
    const now = new Date()
    const nowIso = now.toISOString()

    // Query for active reservations that have passed their expiration date
    const reservationsQuery = query(
      collection(db, 'reservations'),
      where('status', '==', 'Active')
    )

    const snapshot = await getDocs(reservationsQuery)
    const expiredReservations = snapshot.docs.filter((doc) => {
      const data = doc.data() as Record<string, unknown>
      const expiresAt = toDate(data.expiresAt)
      return expiresAt && expiresAt < now
    })

    if (expiredReservations.length === 0) {
      return 0
    }

    // Process each expired reservation
    let expiredCount = 0
    for (const reservationDoc of expiredReservations) {
      const reservationId = reservationDoc.id
      const data = reservationDoc.data() as Record<string, unknown>
      const reservationRef = doc(db, 'reservations', reservationId)
      const reservationItems = parseReservationItems(data.items)

      if (reservationItems.length === 0) {
        continue
      }

      const pendingLogs: Array<{
        actionType: 'reservation_release'
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
      }> = []

      try {
        await runTransaction(db, async (transaction) => {
          // Verify reservation is still active
          const freshSnapshot = await transaction.get(reservationRef)
          if (!freshSnapshot.exists()) {
            throw new Error('RESERVATION_NOT_FOUND')
          }

          const freshData = freshSnapshot.data() as Record<string, unknown>
          const freshStatus = freshData.status as string
          if (freshStatus !== 'Active') {
            throw new Error('RESERVATION_NOT_ACTIVE')
          }

          // Release reserved stock for each item
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
              remarks: `Reservation expired - ${SYSTEM_CANCELLATION_REASON}`,
            })
          }

          // Update reservation to expired status
          transaction.update(reservationRef, {
            status: 'Expired',
            cancelledAt: serverTimestamp(),
            cancelledByName: 'System',
            cancellationReason: SYSTEM_CANCELLATION_REASON,
            cancellationReasonType: 'system',
            updatedAt: nowIso,
          })
        })

        // Create stock logs after transaction succeeds
        const systemProcessedBy = {
          uid: 'system',
          email: 'system@sustain-invi2.local',
          name: 'System',
        }

        await Promise.all(
          pendingLogs.map((log) =>
            createStockLog({
              actionType: log.actionType,
              itemId: log.itemId,
              itemName: log.itemName,
              condition: log.condition,
              quantityBefore: log.quantityBefore,
              quantityChanged: log.quantityChanged,
              quantityAfter: log.quantityAfter,
              stockBefore: log.stockBefore,
              stockAfter: log.stockAfter,
              reservedBefore: log.reservedBefore,
              reservedAfter: log.reservedAfter,
              user: systemProcessedBy,
              relatedId: reservationId,
              remarks: log.remarks,
            })
          )
        )

        expiredCount++
      } catch (error) {
        console.error(`Failed to expire reservation ${reservationId}:`, error)
        // Continue with next reservation on error
      }
    }

    return expiredCount
  } catch (error) {
    console.error('expireReservations error:', error)
    return 0
  }
}
