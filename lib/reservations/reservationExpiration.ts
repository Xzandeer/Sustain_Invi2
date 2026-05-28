// Auto-expires reservations after 3 days and releases reserved stock back to inventory
import { collection, doc, getDocs, query, runTransaction, serverTimestamp, where } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { createStockLog, getProcessedByInfo } from '@/lib/server/inventory'
import { toDate, toNumber } from '@/lib/server/salesInventoryMetrics'
import { SYSTEM_CANCELLATION_REASON } from '@/lib/reservations/cancellationReasons'

interface ReservationItemRecord {
  id: string
  name: string
  quantity: number
  price: number
  condition: 'New' | 'Refurbished'
}

// Helper function to safely parse reservation items array
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

      // Only include valid items with id, name, and positive quantity
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

    // Step 1: Query for all active reservations
    const reservationsQuery = query(
      collection(db, 'reservations'),
      where('status', '==', 'Active')
    )

    const snapshot = await getDocs(reservationsQuery)

    // Step 2: Filter to find only those past their expiresAt date
    const expiredReservations = snapshot.docs.filter((doc) => {
      const data = doc.data() as Record<string, unknown>
      const expiresAt = toDate(data.expiresAt)
      return expiresAt && expiresAt < now
    })

    if (expiredReservations.length === 0) {
      return 0
    }

    // Step 3: Process each expired reservation
    let expiredCount = 0
    for (const reservationDoc of expiredReservations) {
      const reservationId = reservationDoc.id
      const data = reservationDoc.data() as Record<string, unknown>
      const reservationRef = doc(db, 'reservations', reservationId)
      const reservationItems = parseReservationItems(data.items)

      if (reservationItems.length === 0) {
        continue
      }

      // Prepare to track stock changes for logging
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
        // Use transaction to ensure atomic updates (read inventory and update reservation together)
        await runTransaction(db, async (transaction) => {
          // Step 1: Verify reservation still exists and is active (prevent duplicate expiration)
          const freshSnapshot = await transaction.get(reservationRef)
          if (!freshSnapshot.exists()) {
            throw new Error('RESERVATION_NOT_FOUND')
          }

          const freshData = freshSnapshot.data() as Record<string, unknown>
          const freshStatus = freshData.status as string
          if (freshStatus !== 'Active') {
            throw new Error('RESERVATION_NOT_ACTIVE')
          }

          // Step 2: Release reserved stock for each item in the reservation
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

            // Validate reserved stock is sufficient
            if (item.quantity > currentReservedStock || nextReservedStock < 0) {
              throw new Error('INVALID_RESERVED_STOCK')
            }

            // Reduce reservedStock (stock itself stays same, just no longer reserved)
            transaction.update(inventoryRef, {
              reservedStock: nextReservedStock,
              updatedAt: nowIso,
            })

            // Track the change for stock log creation
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

          // Step 3: Mark reservation as expired
          transaction.update(reservationRef, {
            status: 'Expired',
            cancelledAt: serverTimestamp(),
            cancelledByName: 'System',
            cancellationReason: SYSTEM_CANCELLATION_REASON,
            cancellationReasonType: 'system',
            updatedAt: nowIso,
          })
        })

        // Step 4: Create stock logs after transaction succeeds
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
        // RESERVATION_NOT_ACTIVE / RESERVATION_NOT_FOUND are expected race-condition errors
        // that occur when two concurrent calls try to expire the same reservation.
        // Silently skip them — the reservation was already handled by the other call.
        const msg = error instanceof Error ? error.message : ''
        if (msg !== 'RESERVATION_NOT_ACTIVE' && msg !== 'RESERVATION_NOT_FOUND') {
          console.error(`Failed to expire reservation ${reservationId}:`, error)
        }
        // Continue with next reservation on error (don't stop entire batch)
      }
    }

    return expiredCount
  } catch (error) {
    console.error('expireReservations error:', error)
    return 0
  }
}
