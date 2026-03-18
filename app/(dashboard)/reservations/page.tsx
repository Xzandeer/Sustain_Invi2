'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
} from 'firebase/firestore'
import { CheckCircle2, Package, XCircle } from 'lucide-react'
import ProtectedRoute from '@/components/ProtectedRoute'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { db } from '@/lib/firebase'
import { toDate, toNumber } from '@/lib/server/salesInventoryMetrics'

type ReservationStatus = 'Active' | 'Completed' | 'Cancelled' | 'Expired'

interface ReservationItem {
  id: string
  name: string
  quantity: number
  price: number
}

interface Reservation {
  id: string
  items: ReservationItem[]
  customer: string
  createdAt: Date | null
  expiresAt: Date | null
  status: ReservationStatus
}

const formatDate = (value: Date | null) => {
  if (!value) return 'Pending timestamp'
  return value.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

const badgeClassNames: Record<ReservationStatus, string> = {
  Active: 'bg-amber-100 text-amber-800',
  Completed: 'bg-emerald-100 text-emerald-800',
  Cancelled: 'bg-rose-100 text-rose-800',
  Expired: 'bg-slate-200 text-slate-700',
}

export default function ReservationsPage() {
  return (
    <ProtectedRoute>
      <ReservationsContent />
    </ProtectedRoute>
  )
}

function ReservationsContent() {
  const [reservations, setReservations] = useState<Reservation[]>([])
  const [loading, setLoading] = useState(true)
  const [actionId, setActionId] = useState<string | null>(null)
  const [pageError, setPageError] = useState('')

  useEffect(() => {
    const reservationsQuery = query(collection(db, 'reservations'), orderBy('createdAt', 'desc'))

    const unsubscribeReservations = onSnapshot(
      reservationsQuery,
      (snapshot) => {
        const records = snapshot.docs.map((reservationDoc) => {
          const data = reservationDoc.data() as Record<string, unknown>
          const items = Array.isArray(data.items)
            ? data.items
                .map((item) => {
                  const reservationItem = item as Record<string, unknown>
                  const name = typeof reservationItem.name === 'string' ? reservationItem.name.trim() : ''
                  const id = typeof reservationItem.id === 'string' ? reservationItem.id : ''

                  if (!id || !name) return null

                  return {
                    id,
                    name,
                    quantity: Math.max(0, toNumber(reservationItem.quantity, 0)),
                    price: Math.max(0, toNumber(reservationItem.price, 0)),
                  } satisfies ReservationItem
                })
                .filter((item): item is ReservationItem => item !== null && item.quantity > 0)
            : []

          return {
            id: reservationDoc.id,
            items,
            customer:
              typeof data.customer === 'string' && data.customer.trim()
                ? data.customer.trim()
                : typeof data.customerName === 'string' && data.customerName.trim()
                  ? data.customerName.trim()
                  : 'Walk-in Customer',
            createdAt: toDate(data.createdAt ?? data.reservationDate),
            expiresAt: toDate(data.expiresAt),
            status:
              data.status === 'Active' || data.status === 'Completed' || data.status === 'Cancelled' || data.status === 'Expired'
                ? data.status
                : 'Active',
          } satisfies Reservation
        })

        setReservations(records)
        setLoading(false)
      },
      (error) => {
        console.error('Error loading reservations:', error)
        setPageError('Failed to load reservations.')
        setLoading(false)
      }
    )

    return () => {
      unsubscribeReservations()
    }
  }, [])

  const activeReservations = useMemo(
    () => reservations.filter((reservation) => reservation.status === 'Active').length,
    [reservations]
  )

  const handleCompleteReservation = async (reservation: Reservation) => {
    if (reservation.status !== 'Active') return
    if (!window.confirm(`Complete reservation for ${reservation.customer}?`)) return

    setActionId(reservation.id)
    try {
      const reservationRef = doc(db, 'reservations', reservation.id)
      const saleRef = doc(collection(db, 'sales'))

      await runTransaction(db, async (transaction) => {
        const reservationSnapshot = await transaction.get(reservationRef)
        if (!reservationSnapshot.exists()) {
          throw new Error('Reservation not found')
        }

        const data = reservationSnapshot.data() as Record<string, unknown>
        if (data.status !== 'Active') {
          throw new Error('Reservation is no longer active.')
        }

        const reservationItems = Array.isArray(data.items)
          ? data.items
              .map((item) => {
                const reservationItem = item as Record<string, unknown>
                const id = typeof reservationItem.id === 'string' ? reservationItem.id : ''
                const name = typeof reservationItem.name === 'string' ? reservationItem.name.trim() : ''
                const quantity = Math.max(0, toNumber(reservationItem.quantity, 0))
                const price = Math.max(0, toNumber(reservationItem.price, 0))

                if (!id || !name || quantity <= 0) return null

                return { id, name, quantity, price }
              })
              .filter((item): item is ReservationItem => item !== null)
          : reservation.items

        if (reservationItems.length === 0) {
          throw new Error('Reservation has no items.')
        }

        const customer =
          typeof data.customer === 'string' && data.customer.trim()
            ? data.customer.trim()
            : reservation.customer

        const saleItems: Array<{
          itemId: string
          name: string
          quantity: number
          price: number
          categoryId: string
          categoryName: string
          status: string
        }> = []

        for (const item of reservationItems) {
          const inventoryRef = doc(db, 'inventory', item.id)
          const inventorySnapshot = await transaction.get(inventoryRef)
          if (!inventorySnapshot.exists()) {
            throw new Error(`${item.name} no longer exists in inventory.`)
          }

          const inventoryData = inventorySnapshot.data() as Record<string, unknown>
          const currentStock = Math.max(0, toNumber(inventoryData.stock ?? inventoryData.quantity, 0))
          const currentReservedStock = Math.max(0, toNumber(inventoryData.reservedStock, 0))

          if (item.quantity > currentReservedStock) {
            throw new Error(`Reserved quantity is invalid for ${item.name}.`)
          }

          if (item.quantity > currentStock) {
            throw new Error(`Insufficient stock to complete reservation for ${item.name}.`)
          }

          const nextStock = currentStock - item.quantity
          const nextReservedStock = Math.max(0, currentReservedStock - item.quantity)
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
            updatedAt: new Date().toISOString(),
          })

          saleItems.push({
            itemId: item.id,
            name: item.name,
            quantity: item.quantity,
            price: item.price,
            categoryId,
            categoryName,
            status: 'completed',
          })
        }

        const totalAmount = saleItems.reduce((sum, item) => sum + item.quantity * item.price, 0)
        const categoryNames = Array.from(new Set(saleItems.map((item) => item.categoryName)))

        transaction.set(saleRef, {
          ...(saleItems.length === 1 ? { itemId: saleItems[0].itemId } : {}),
          id: saleRef.id,
          items: saleItems,
          categoryName: categoryNames.join(', '),
          category: categoryNames.join(', '),
          customer,
          totalAmount,
          quantity: saleItems.reduce((sum, item) => sum + item.quantity, 0),
          total: totalAmount,
          amount: totalAmount,
          status: 'Completed',
          createdAt: serverTimestamp(),
        })

        transaction.update(reservationRef, {
          status: 'Completed',
          completedAt: serverTimestamp(),
        })
      })
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Failed to complete reservation.')
    } finally {
      setActionId(null)
    }
  }

  const handleCancelReservation = async (reservation: Reservation) => {
    if (reservation.status !== 'Active') return
    if (!window.confirm(`Cancel reservation for ${reservation.customer}?`)) return

    setActionId(reservation.id)
    try {
      const reservationRef = doc(db, 'reservations', reservation.id)

      await runTransaction(db, async (transaction) => {
        const reservationSnapshot = await transaction.get(reservationRef)
        if (!reservationSnapshot.exists()) {
          throw new Error('Reservation not found')
        }

        const reservationData = reservationSnapshot.data() as Record<string, unknown>
        if (reservationData.status !== 'Active') {
          throw new Error('Reservation is no longer active.')
        }

        const reservationItems = Array.isArray(reservationData.items)
          ? reservationData.items
              .map((item) => {
                const reservationItem = item as Record<string, unknown>
                const id = typeof reservationItem.id === 'string' ? reservationItem.id : ''
                const name = typeof reservationItem.name === 'string' ? reservationItem.name.trim() : ''
                const quantity = Math.max(0, toNumber(reservationItem.quantity, 0))
                const price = Math.max(0, toNumber(reservationItem.price, 0))

                if (!id || !name || quantity <= 0) return null

                return { id, name, quantity, price }
              })
              .filter((item): item is ReservationItem => item !== null)
          : reservation.items

        for (const item of reservationItems) {
          const inventoryRef = doc(db, 'inventory', item.id)
          const inventorySnapshot = await transaction.get(inventoryRef)
          if (!inventorySnapshot.exists()) {
            throw new Error(`${item.name} no longer exists in inventory.`)
          }

          const inventoryData = inventorySnapshot.data() as Record<string, unknown>
          const currentReservedStock = Math.max(0, toNumber(inventoryData.reservedStock, 0))

          if (item.quantity > currentReservedStock) {
            throw new Error(`Reserved quantity is invalid for ${item.name}.`)
          }

          transaction.update(inventoryRef, {
            reservedStock: Math.max(0, currentReservedStock - item.quantity),
            updatedAt: new Date().toISOString(),
          })
        }

        transaction.update(reservationRef, {
          status: 'Cancelled',
          cancelledAt: serverTimestamp(),
        })
      })
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Failed to cancel reservation.')
    } finally {
      setActionId(null)
    }
  }

  return (
    <main className="min-h-[calc(100vh-64px)] bg-slate-100 px-4 py-8 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-[1700px] space-y-6">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-4xl font-bold text-slate-900">Reservations</h1>
            <p className="mt-1 text-lg text-slate-600">Review active reservations, complete reserved orders, or release held stock.</p>
          </div>
          <div className="rounded-xl border bg-white px-4 py-3 text-sm text-slate-700 shadow-sm">
            Active Reservations: <span className="font-semibold text-slate-900">{activeReservations}</span>
          </div>
        </header>

        <section className="rounded-xl border bg-white p-6 shadow-sm">
          <div className="mb-4 flex items-center gap-2">
            <Package className="h-5 w-5 text-sky-900" />
            <h2 className="text-xl font-semibold text-slate-900">Reservation Records</h2>
          </div>

          {pageError ? <p className="mb-4 text-sm text-red-600">{pageError}</p> : null}

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item Name</TableHead>
                <TableHead>Customer Name</TableHead>
                <TableHead>Quantity Reserved</TableHead>
                <TableHead>Reservation Date</TableHead>
                <TableHead>Expires At</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-slate-500">
                    Loading reservations...
                  </TableCell>
                </TableRow>
              ) : reservations.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-slate-500">
                    No reservations found.
                  </TableCell>
                </TableRow>
              ) : (
                reservations.map((reservation) => (
                  <TableRow key={reservation.id}>
                    <TableCell className="font-medium text-slate-900">
                      {reservation.items.length > 0
                        ? reservation.items.map((item) => item.name).join(', ')
                        : 'No items'}
                    </TableCell>
                    <TableCell>{reservation.customer}</TableCell>
                    <TableCell>{reservation.items.reduce((sum, item) => sum + item.quantity, 0)}</TableCell>
                    <TableCell>{formatDate(reservation.createdAt)}</TableCell>
                    <TableCell>{formatDate(reservation.expiresAt)}</TableCell>
                    <TableCell>
                      <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${badgeClassNames[reservation.status]}`}>
                        {reservation.status}
                      </span>
                    </TableCell>
                    <TableCell>
                      {reservation.status === 'Active' ? (
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            size="sm"
                            disabled={actionId === reservation.id}
                            onClick={() => handleCompleteReservation(reservation)}
                            className="bg-emerald-600 hover:bg-emerald-700"
                          >
                            <CheckCircle2 className="mr-1 h-4 w-4" />
                            Complete Sale
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="destructive"
                            disabled={actionId === reservation.id}
                            onClick={() => handleCancelReservation(reservation)}
                          >
                            <XCircle className="mr-1 h-4 w-4" />
                            Cancel
                          </Button>
                        </div>
                      ) : (
                        <span className="text-sm text-slate-500">No actions available</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </section>
      </div>
    </main>
  )
}
