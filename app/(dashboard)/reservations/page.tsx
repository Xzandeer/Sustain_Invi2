'use client'

import { FormEvent, useEffect, useMemo, useState } from 'react'
import {
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
} from 'firebase/firestore'
import { CalendarCheck2, CheckCircle2, Package, XCircle } from 'lucide-react'
import ProtectedRoute from '@/components/ProtectedRoute'
import InventorySearchSelect from '@/components/InventorySearchSelect'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { db } from '@/lib/firebase'
import { toDate, toNumber } from '@/lib/server/salesInventoryMetrics'

type ReservationStatus = 'Reserved' | 'Completed' | 'Cancelled'

interface InventoryItem {
  id: string
  name: string
  category: string
  price: number
  quantity: number
  minStock: number
  isDeleted?: boolean
}

interface Reservation {
  id: string
  itemId: string
  itemName: string
  customerName: string
  quantity: number
  reservationDate: Date | null
  status: ReservationStatus
  price: number
  categoryName: string
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
  Reserved: 'bg-amber-100 text-amber-800',
  Completed: 'bg-emerald-100 text-emerald-800',
  Cancelled: 'bg-rose-100 text-rose-800',
}

export default function ReservationsPage() {
  return (
    <ProtectedRoute>
      <ReservationsContent />
    </ProtectedRoute>
  )
}

function ReservationsContent() {
  const [inventoryItems, setInventoryItems] = useState<InventoryItem[]>([])
  const [reservations, setReservations] = useState<Reservation[]>([])
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [actionId, setActionId] = useState<string | null>(null)
  const [formError, setFormError] = useState('')
  const [pageError, setPageError] = useState('')

  const [selectedItemId, setSelectedItemId] = useState('')
  const [customerName, setCustomerName] = useState('')
  const [quantityReserved, setQuantityReserved] = useState('')

  useEffect(() => {
    const inventoryQuery = query(collection(db, 'inventory'), orderBy('name'))
    const reservationsQuery = query(collection(db, 'reservations'), orderBy('reservationDate', 'desc'))

    const unsubscribeInventory = onSnapshot(
      inventoryQuery,
      (snapshot) => {
        const items: InventoryItem[] = []
        snapshot.docs.forEach((itemDoc) => {
          const data = itemDoc.data() as Record<string, unknown>
          const name = typeof data.name === 'string' ? data.name.trim() : ''
          if (!name || data.isDeleted === true) return

          items.push({
            id: itemDoc.id,
            name,
            category:
              (typeof data.categoryName === 'string' && data.categoryName.trim()) ||
              (typeof data.category === 'string' && data.category.trim()) ||
              'Uncategorized',
            price: Math.max(0, toNumber(data.price, 0)),
            quantity: Math.max(0, toNumber(data.stock ?? data.quantity, 0)),
            minStock: Math.max(0, toNumber(data.minStock, 0)),
            isDeleted: false,
          })
        })

        setInventoryItems(items)
      },
      (error) => {
        console.error('Error loading inventory for reservations:', error)
        setPageError('Failed to load inventory.')
        setLoading(false)
      }
    )

    const unsubscribeReservations = onSnapshot(
      reservationsQuery,
      (snapshot) => {
        const records = snapshot.docs.map((reservationDoc) => {
          const data = reservationDoc.data() as Record<string, unknown>
          return {
            id: reservationDoc.id,
            itemId: typeof data.itemId === 'string' ? data.itemId : '',
            itemName: typeof data.itemName === 'string' ? data.itemName : 'Unnamed Item',
            customerName: typeof data.customerName === 'string' ? data.customerName : 'Unknown Customer',
            quantity: Math.max(0, toNumber(data.quantity, 0)),
            reservationDate: toDate(data.reservationDate),
            status:
              data.status === 'Completed' || data.status === 'Cancelled' || data.status === 'Reserved'
                ? data.status
                : 'Reserved',
            price: Math.max(0, toNumber(data.price, 0)),
            categoryName:
              (typeof data.categoryName === 'string' && data.categoryName.trim()) ||
              (typeof data.category === 'string' && data.category.trim()) ||
              'Uncategorized',
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
      unsubscribeInventory()
      unsubscribeReservations()
    }
  }, [])

  const selectedItem = useMemo(
    () => inventoryItems.find((item) => item.id === selectedItemId) ?? null,
    [inventoryItems, selectedItemId]
  )

  const reservableItems = useMemo(
    () => inventoryItems.filter((item) => item.quantity > 0),
    [inventoryItems]
  )

  const activeReservations = useMemo(
    () => reservations.filter((reservation) => reservation.status === 'Reserved').length,
    [reservations]
  )

  const handleCreateReservation = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setFormError('')

    const quantity = Math.floor(Number(quantityReserved))
    if (!selectedItem || !Number.isFinite(quantity) || quantity <= 0) {
      setFormError('Select an item and enter a valid reservation quantity.')
      return
    }

    if (quantity > selectedItem.quantity) {
      setFormError('Cannot reserve more than available stock.')
      return
    }

    const trimmedCustomerName = customerName.trim()
    if (!trimmedCustomerName) {
      setFormError('Customer name is required.')
      return
    }

    setSubmitting(true)
    try {
      const reservationRef = doc(collection(db, 'reservations'))
      const inventoryRef = doc(db, 'inventory', selectedItem.id)

      await runTransaction(db, async (transaction) => {
        const inventorySnapshot = await transaction.get(inventoryRef)
        if (!inventorySnapshot.exists()) {
          throw new Error('Item not found')
        }

        const currentData = inventorySnapshot.data() as Record<string, unknown>
        const currentQuantity = Math.max(0, toNumber(currentData.quantity, 0))
        if (quantity > currentQuantity) {
          throw new Error('Cannot reserve more than available stock.')
        }

        const updatedQuantity = currentQuantity - quantity
        transaction.update(inventoryRef, {
          quantity: updatedQuantity,
          stock: updatedQuantity,
          updatedAt: new Date().toISOString(),
        })

        transaction.set(reservationRef, {
          id: reservationRef.id,
          itemId: selectedItem.id,
          itemName: selectedItem.name,
          customerName: trimmedCustomerName,
          quantity,
          price: selectedItem.price,
          categoryName: selectedItem.category,
          category: selectedItem.category,
          reservationDate: serverTimestamp(),
          status: 'Reserved',
        })
      })

      setSelectedItemId('')
      setCustomerName('')
      setQuantityReserved('')
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Failed to create reservation.')
    } finally {
      setSubmitting(false)
    }
  }

  const handleCompleteReservation = async (reservation: Reservation) => {
    if (reservation.status !== 'Reserved') return
    if (!window.confirm(`Complete reservation for ${reservation.itemName}?`)) return

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
        if (data.status !== 'Reserved') {
          throw new Error('Reservation is no longer active.')
        }

        const itemId = typeof data.itemId === 'string' ? data.itemId : reservation.itemId
        const itemName =
          typeof data.itemName === 'string' && data.itemName.trim() ? data.itemName.trim() : reservation.itemName
        const customer =
          typeof data.customerName === 'string' && data.customerName.trim()
            ? data.customerName.trim()
            : reservation.customerName
        const quantity = Math.max(0, toNumber(data.quantity, reservation.quantity))
        const price = Math.max(0, toNumber(data.price, reservation.price))
        const categoryName =
          (typeof data.categoryName === 'string' && data.categoryName.trim()) ||
          (typeof data.category === 'string' && data.category.trim()) ||
          reservation.categoryName

        transaction.set(saleRef, {
          id: saleRef.id,
          itemId,
          itemName,
          categoryName,
          category: categoryName,
          customer,
          quantity,
          price,
          total: quantity * price,
          amount: quantity * price,
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
    if (reservation.status !== 'Reserved') return
    if (!window.confirm(`Cancel reservation for ${reservation.itemName}?`)) return

    setActionId(reservation.id)
    try {
      const reservationRef = doc(db, 'reservations', reservation.id)

      await runTransaction(db, async (transaction) => {
        const reservationSnapshot = await transaction.get(reservationRef)
        if (!reservationSnapshot.exists()) {
          throw new Error('Reservation not found')
        }

        const reservationData = reservationSnapshot.data() as Record<string, unknown>
        if (reservationData.status !== 'Reserved') {
          throw new Error('Reservation is no longer active.')
        }

        const itemId = typeof reservationData.itemId === 'string' ? reservationData.itemId : reservation.itemId
        const quantity = Math.max(0, toNumber(reservationData.quantity, reservation.quantity))

        const inventoryRef = doc(db, 'inventory', itemId)
        const inventorySnapshot = await transaction.get(inventoryRef)
        if (!inventorySnapshot.exists()) {
          throw new Error('Inventory item not found')
        }

        const inventoryData = inventorySnapshot.data() as Record<string, unknown>
        const currentQuantity = Math.max(0, toNumber(inventoryData.quantity, 0))
        const updatedQuantity = currentQuantity + quantity

        transaction.update(inventoryRef, {
          quantity: updatedQuantity,
          stock: updatedQuantity,
          updatedAt: new Date().toISOString(),
        })

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
            <p className="mt-1 text-lg text-slate-600">Reserve inventory, complete reserved orders, and restore stock on cancellation.</p>
          </div>
          <div className="rounded-xl border bg-white px-4 py-3 text-sm text-slate-700 shadow-sm">
            Active Reservations: <span className="font-semibold text-slate-900">{activeReservations}</span>
          </div>
        </header>

        <section className="rounded-xl border bg-white p-6 shadow-sm">
          <div className="mb-4 flex items-center gap-2">
            <CalendarCheck2 className="h-5 w-5 text-sky-900" />
            <h2 className="text-xl font-semibold text-slate-900">Create Reservation</h2>
          </div>

          <form onSubmit={handleCreateReservation} className="grid gap-4 lg:grid-cols-4">
            <div className="lg:col-span-2">
              <label className="mb-1 block text-sm font-medium text-slate-700">Inventory Item</label>
              <InventorySearchSelect
                items={reservableItems}
                value={selectedItemId}
                onValueChange={setSelectedItemId}
                placeholder="Search reservable item"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700">Customer Name</label>
              <input
                type="text"
                value={customerName}
                onChange={(event) => setCustomerName(event.target.value)}
                placeholder="Enter customer name"
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-slate-500"
                required
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700">Quantity Reserved</label>
              <input
                type="number"
                min={1}
                value={quantityReserved}
                onChange={(event) => setQuantityReserved(event.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-slate-500"
                required
              />
            </div>

            <div className="lg:col-span-4 flex flex-wrap items-center gap-3">
              {selectedItem && (
                <div className="w-full rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
                  <p><span className="font-semibold text-slate-900">Item:</span> {selectedItem.name}</p>
                  <p><span className="font-semibold text-slate-900">Category:</span> {selectedItem.category}</p>
                  <p><span className="font-semibold text-slate-900">Price:</span> PHP {selectedItem.price.toFixed(2)}</p>
                  <p><span className="font-semibold text-slate-900">Stock Available:</span> {selectedItem.quantity}</p>
                </div>
              )}
              <Button type="submit" disabled={submitting}>
                {submitting ? 'Saving...' : 'Create Reservation'}
              </Button>
            </div>

            {formError && <p className="text-sm text-red-600 lg:col-span-4">{formError}</p>}
            {pageError && <p className="text-sm text-red-600 lg:col-span-4">{pageError}</p>}
          </form>
        </section>

        <section className="rounded-xl border bg-white p-6 shadow-sm">
          <div className="mb-4 flex items-center gap-2">
            <Package className="h-5 w-5 text-sky-900" />
            <h2 className="text-xl font-semibold text-slate-900">Reservation Records</h2>
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item Name</TableHead>
                <TableHead>Customer Name</TableHead>
                <TableHead>Quantity Reserved</TableHead>
                <TableHead>Reservation Date</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-slate-500">
                    Loading reservations...
                  </TableCell>
                </TableRow>
              ) : reservations.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-slate-500">
                    No reservations found.
                  </TableCell>
                </TableRow>
              ) : (
                reservations.map((reservation) => (
                  <TableRow key={reservation.id}>
                    <TableCell className="font-medium text-slate-900">{reservation.itemName}</TableCell>
                    <TableCell>{reservation.customerName}</TableCell>
                    <TableCell>{reservation.quantity}</TableCell>
                    <TableCell>{formatDate(reservation.reservationDate)}</TableCell>
                    <TableCell>
                      <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${badgeClassNames[reservation.status]}`}>
                        {reservation.status}
                      </span>
                    </TableCell>
                    <TableCell>
                      {reservation.status === 'Reserved' ? (
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            size="sm"
                            disabled={actionId === reservation.id}
                            onClick={() => handleCompleteReservation(reservation)}
                            className="bg-emerald-600 hover:bg-emerald-700"
                          >
                            <CheckCircle2 className="mr-1 h-4 w-4" />
                            Complete Reservation
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="destructive"
                            disabled={actionId === reservation.id}
                            onClick={() => handleCancelReservation(reservation)}
                          >
                            <XCircle className="mr-1 h-4 w-4" />
                            Cancel Reservation
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
