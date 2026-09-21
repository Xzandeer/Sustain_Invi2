// Releases every hold that has passed the expiry stamped on it.
//
// This used to run in the browser, on the Reservations page. That worked only
// because the database was open: the sweep writes to `inventory` and
// `reservations`, and no client is allowed to do that. It now runs here, where
// the caller's token is verified first and the Admin SDK does the writing.
//
// The hold period itself is a store setting - see Settings, Reservation Hold
// Period - so nothing here needs to know how long it is. A lapsed hold can be
// reinstated from the Reservations page if the stock is still on the shelf.

import { NextResponse, type NextRequest } from 'next/server'
import { FieldValue, type DocumentReference } from 'firebase-admin/firestore'
import { getAdminDb } from '@/lib/firebaseAdmin'
import { createStockLog } from '@/lib/server/inventory'
import { toDate, toNumber } from '@/lib/server/salesInventoryMetrics'
import { SYSTEM_CANCELLATION_REASON } from '@/lib/reservations/cancellationReasons'
import { guardRequest } from '@/lib/server/authorize'

export const dynamic = 'force-dynamic'

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

// The sweep is triggered by whoever opens the Reservations page, but the work
// is the system's, not theirs - the logs say System so the audit trail does not
// credit a staff member with a release they did not perform.
const SYSTEM_USER = {
  uid: 'system',
  email: 'system@sustain-invi2.local',
  name: 'System',
}

export async function POST(req: NextRequest) {
  const denied = await guardRequest(req, 'canManageReservations')
  if (denied) return denied

  try {
    const adminDb = getAdminDb()
    const now = new Date()
    const nowIso = now.toISOString()

    const snapshot = await adminDb
      .collection('reservations')
      .where('status', '==', 'Active')
      .get()

    const lapsed = snapshot.docs.filter((d) => {
      const expiresAt = toDate((d.data() as Record<string, unknown>).expiresAt)
      return expiresAt && expiresAt < now
    })

    if (lapsed.length === 0) {
      return NextResponse.json({ expired: 0 })
    }

    let expiredCount = 0

    for (const reservationDoc of lapsed) {
      const reservationId = reservationDoc.id
      const reservationRef = adminDb.collection('reservations').doc(reservationId)
      const reservationItems = parseReservationItems(
        (reservationDoc.data() as Record<string, unknown>).items
      )
      if (reservationItems.length === 0) continue

      const pendingLogs: Array<{
        itemId: string
        itemName: string
        condition: 'New' | 'Refurbished'
        availableBefore: number
        quantity: number
        currentStock: number
        currentReservedStock: number
        nextReservedStock: number
      }> = []

      try {
        await adminDb.runTransaction(async (transaction) => {
          pendingLogs.length = 0 // a retried transaction must not double-log

          // Re-check under the transaction: two tabs open at once would
          // otherwise both try to expire the same hold.
          const freshSnapshot = await transaction.get(reservationRef)
          if (!freshSnapshot.exists) throw new Error('RESERVATION_NOT_FOUND')
          if ((freshSnapshot.data() as Record<string, unknown>).status !== 'Active') {
            throw new Error('RESERVATION_NOT_ACTIVE')
          }

          // Every read before any write - Firestore rejects the reverse, which
          // is what made the old browser version fail on multi-item holds.
          const releases: Array<{
            ref: DocumentReference
            item: ReservationItemRecord
            currentStock: number
            currentReservedStock: number
            availableBefore: number
            nextReservedStock: number
          }> = []

          for (const item of reservationItems) {
            const inventoryRef = adminDb.collection('inventory').doc(item.id)
            const inventorySnapshot = await transaction.get(inventoryRef)
            if (!inventorySnapshot.exists) throw new Error('ITEM_NOT_FOUND')

            const inventoryData = inventorySnapshot.data() as Record<string, unknown>
            const currentStock = Math.max(0, toNumber(inventoryData.stock ?? inventoryData.quantity, 0))
            const currentReservedStock = Math.max(0, toNumber(inventoryData.reservedStock, 0))
            const availableBefore = Math.max(0, currentStock - currentReservedStock)
            const nextReservedStock = currentReservedStock - item.quantity

            if (item.quantity > currentReservedStock || nextReservedStock < 0) {
              throw new Error('INVALID_RESERVED_STOCK')
            }

            releases.push({
              ref: inventoryRef,
              item,
              currentStock,
              currentReservedStock,
              availableBefore,
              nextReservedStock,
            })
          }

          for (const r of releases) {
            // Stock itself is unchanged - the units were never sold, they just
            // stop being held for someone.
            transaction.update(r.ref, {
              reservedStock: r.nextReservedStock,
              updatedAt: nowIso,
            })

            pendingLogs.push({
              itemId: r.item.id,
              itemName: r.item.name,
              condition: r.item.condition,
              availableBefore: r.availableBefore,
              quantity: r.item.quantity,
              currentStock: r.currentStock,
              currentReservedStock: r.currentReservedStock,
              nextReservedStock: r.nextReservedStock,
            })
          }

          transaction.update(reservationRef, {
            status: 'Expired',
            cancelledAt: FieldValue.serverTimestamp(),
            cancelledByName: 'System',
            cancellationReason: SYSTEM_CANCELLATION_REASON,
            cancellationReasonType: 'system',
            updatedAt: nowIso,
          })
        })

        await Promise.all(
          pendingLogs.map((log) =>
            createStockLog({
              actionType: 'reservation_release',
              itemId: log.itemId,
              itemName: log.itemName,
              condition: log.condition,
              quantityBefore: log.availableBefore,
              quantityChanged: log.quantity,
              quantityAfter: log.availableBefore + log.quantity,
              stockBefore: log.currentStock,
              stockAfter: log.currentStock,
              reservedBefore: log.currentReservedStock,
              reservedAfter: log.nextReservedStock,
              user: SYSTEM_USER,
              relatedId: reservationId,
              remarks: `Reservation expired - ${SYSTEM_CANCELLATION_REASON}`,
            })
          )
        )

        expiredCount++
      } catch (error) {
        // NOT_ACTIVE / NOT_FOUND are the expected outcome when two callers race
        // for the same hold. The other one won; nothing is wrong.
        const msg = error instanceof Error ? error.message : ''
        if (msg !== 'RESERVATION_NOT_ACTIVE' && msg !== 'RESERVATION_NOT_FOUND') {
          console.error(`[reservations/expire] ${reservationId}:`, error)
        }
        // Keep going - one bad hold must not stop the sweep.
      }
    }

    return NextResponse.json({ expired: expiredCount })
  } catch (error) {
    console.error('[reservations/expire] error:', error)
    return NextResponse.json({ error: 'Failed to expire reservations.' }, { status: 500 })
  }
}
