'use client'

import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import { collection, onSnapshot, orderBy, query } from 'firebase/firestore'
import { CheckCircle2, Package, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import ProtectedRoute from '@/components/ProtectedRoute'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { auth, db } from '@/lib/firebase'
import { toDate, toNumber } from '@/lib/server/salesInventoryMetrics'

type ReservationStatus = 'Active' | 'Completed' | 'Cancelled' | 'Expired'

interface ReservationItem {
  id: string
  name: string
  quantity: number
  price: number
  categoryName: string
}

interface Reservation {
  id: string
  reservationNumber: string
  items: ReservationItem[]
  customer: string
  customerEmail: string
  customerContactNumber: string
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
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | ReservationStatus>('all')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [inventoryCategoryById, setInventoryCategoryById] = useState<Record<string, string>>({})
  const deferredSearch = useDeferredValue(search)

  useEffect(() => {
    const unsubscribeInventory = onSnapshot(
      collection(db, 'inventory'),
      (snapshot) => {
        const nextMap = snapshot.docs.reduce<Record<string, string>>((result, itemDoc) => {
          const data = itemDoc.data() as Record<string, unknown>
          const categoryName =
            (typeof data.categoryName === 'string' && data.categoryName.trim()) ||
            (typeof data.category === 'string' && data.category.trim()) ||
            ''

          if (categoryName) {
            result[itemDoc.id] = categoryName
          }

          return result
        }, {})

        setInventoryCategoryById(nextMap)
      },
      (error) => console.error('Error loading inventory categories for reservations:', error)
    )

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
                    categoryName: '',
                  } satisfies ReservationItem
                })
                .filter((item): item is ReservationItem => item !== null && item.quantity > 0)
            : []

          return {
            id: reservationDoc.id,
            reservationNumber:
              typeof data.reservationNumber === 'string' && data.reservationNumber.trim()
                ? data.reservationNumber.trim()
                : reservationDoc.id,
            items,
            customer:
              typeof data.customer === 'string' && data.customer.trim()
                ? data.customer.trim()
                : typeof data.customerName === 'string' && data.customerName.trim()
                  ? data.customerName.trim()
                  : 'Walk-in Customer',
            customerEmail: typeof data.customerEmail === 'string' ? data.customerEmail.trim() : '',
            customerContactNumber:
              typeof data.customerContactNumber === 'string' ? data.customerContactNumber.trim() : '',
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
      unsubscribeInventory()
      unsubscribeReservations()
    }
  }, [])

  const activeReservations = useMemo(
    () => reservations.filter((reservation) => reservation.status === 'Active').length,
    [reservations]
  )

  const searchableReservations = useMemo(
    () =>
      reservations.map((reservation) => {
        const categoryNames = Array.from(
          new Set(
            reservation.items
              .map((item) => inventoryCategoryById[item.id] || item.categoryName)
              .map((name) => name.trim())
              .filter(Boolean)
          )
        )

        return {
          reservation,
          categoryNames,
          searchIndex: [
            reservation.reservationNumber,
            reservation.customer,
            reservation.customerEmail,
            ...reservation.items.map((item) => item.name),
            ...categoryNames,
          ]
            .join(' ')
            .toLowerCase(),
        }
      }),
    [reservations, inventoryCategoryById]
  )

  const categoryOptions = useMemo(() => {
    const optionSet = new Set<string>()

    searchableReservations.forEach(({ categoryNames }) => {
      categoryNames.forEach((name) => optionSet.add(name))
    })

    return Array.from(optionSet).sort((a, b) => a.localeCompare(b))
  }, [searchableReservations])

  const filteredReservations = useMemo(() => {
    const searchTerm = deferredSearch.trim().toLowerCase()
    const startTime = startDate ? new Date(startDate).getTime() : null
    const endTime = endDate ? new Date(new Date(endDate).setHours(23, 59, 59, 999)).getTime() : null

    return searchableReservations
      .filter(({ reservation, categoryNames, searchIndex }) => {
        const matchesSearch = !searchTerm || searchIndex.includes(searchTerm)
        const matchesStatus = statusFilter === 'all' ? true : reservation.status === statusFilter
        const matchesCategory = categoryFilter === 'all' ? true : categoryNames.includes(categoryFilter)
        const createdTime = reservation.createdAt?.getTime()
        const matchesDate =
          createdTime == null
            ? !startTime && !endTime
            : (startTime == null || createdTime >= startTime) && (endTime == null || createdTime <= endTime)

        return matchesSearch && matchesStatus && matchesCategory && matchesDate
      })
      .map(({ reservation }) => reservation)
  }, [searchableReservations, deferredSearch, statusFilter, categoryFilter, startDate, endDate])

  const handleCompleteReservation = async (reservation: Reservation) => {
    if (reservation.status !== 'Active') return
    if (!window.confirm(`Complete reservation for ${reservation.customer}?`)) return

    setActionId(reservation.id)
    try {
      const response = await fetch(`/api/reservations/${reservation.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'complete',
          processedBy: {
            uid: auth.currentUser?.uid ?? '',
            email: auth.currentUser?.email ?? '',
            name: auth.currentUser?.displayName ?? auth.currentUser?.email ?? '',
          },
        }),
      })

      const payload = (await response.json()) as { error?: string }
      if (!response.ok) {
        throw new Error(payload.error || 'Failed to complete reservation.')
      }

      toast.success('Reservation completed successfully.')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to complete reservation.'
      setPageError(message)
      toast.error(message)
    } finally {
      setActionId(null)
    }
  }

  const handleCancelReservation = async (reservation: Reservation) => {
    if (reservation.status !== 'Active') return
    if (!window.confirm(`Cancel reservation for ${reservation.customer}?`)) return

    setActionId(reservation.id)
    try {
      const response = await fetch(`/api/reservations/${reservation.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'cancel',
          processedBy: {
            uid: auth.currentUser?.uid ?? '',
            email: auth.currentUser?.email ?? '',
            name: auth.currentUser?.displayName ?? auth.currentUser?.email ?? '',
          },
        }),
      })

      const payload = (await response.json()) as { error?: string }
      if (!response.ok) {
        throw new Error(payload.error || 'Failed to cancel reservation.')
      }

      toast.success('Reservation cancelled and reserved stock released.')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to cancel reservation.'
      setPageError(message)
      toast.error(message)
    } finally {
      setActionId(null)
    }
  }

  return (
    <main className="min-h-[calc(100vh-64px)] bg-slate-100 px-2.5 py-3 sm:px-3">
      <div className="mx-auto max-w-[1620px] space-y-4">
        <header className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-[1.65rem] font-bold text-slate-900">Reservations</h1>
          </div>
          <div className="rounded-xl border bg-white px-3.5 py-2 text-sm text-slate-700 shadow-sm">
            Active Reservations: <span className="font-semibold text-slate-900">{activeReservations}</span>
          </div>
        </header>

        <section className="rounded-xl border bg-white p-4 shadow-sm">
          <div className="mb-3 flex items-center gap-2">
            <Package className="h-5 w-5 text-sky-900" />
            <h2 className="text-lg font-semibold text-slate-900">Reservation Records</h2>
          </div>
          <div className="mb-4 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            <input
              type="text"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Reservation number, customer, email, or item name"
              className="w-full rounded-lg border border-slate-300 px-3.5 py-2 text-sm text-slate-900 outline-none transition focus:border-slate-500 md:col-span-2"
            />
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as 'all' | ReservationStatus)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-slate-500"
            >
              <option value="all">All Statuses</option>
              <option value="Active">Active</option>
              <option value="Completed">Completed</option>
              <option value="Cancelled">Cancelled</option>
              <option value="Expired">Expired</option>
            </select>
            <select
              value={categoryFilter}
              onChange={(event) => setCategoryFilter(event.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-slate-500"
            >
              <option value="all">All Categories</option>
              {categoryOptions.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
            <input
              type="date"
              value={startDate}
              max={endDate || undefined}
              onChange={(event) => {
                const nextStartDate = event.target.value
                setStartDate(nextStartDate)
                if (endDate && nextStartDate && new Date(endDate) < new Date(nextStartDate)) {
                  setEndDate(nextStartDate)
                }
              }}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-slate-500"
            />
            <input
              type="date"
              value={endDate}
              min={startDate || undefined}
              onChange={(event) => setEndDate(event.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-slate-500"
            />
          </div>

          {pageError ? <p className="mb-4 text-sm text-red-600">{pageError}</p> : null}

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Reservation No.</TableHead>
                <TableHead>Item Name</TableHead>
                <TableHead>Customer Name</TableHead>
                <TableHead>Contact</TableHead>
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
                  <TableCell colSpan={9} className="py-8 text-center text-slate-500">
                    Loading reservations...
                  </TableCell>
                </TableRow>
              ) : filteredReservations.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="py-8 text-center text-slate-500">
                    No reservations found.
                  </TableCell>
                </TableRow>
              ) : (
                filteredReservations.map((reservation) => (
                  <TableRow key={reservation.id}>
                    <TableCell className="font-medium text-slate-900">{reservation.reservationNumber}</TableCell>
                    <TableCell className="font-medium text-slate-900">
                      {reservation.items.length > 0
                        ? reservation.items.map((item) => item.name).join(', ')
                        : 'No items'}
                    </TableCell>
                    <TableCell>{reservation.customer}</TableCell>
                    <TableCell>
                      <div className="text-sm text-slate-700">
                        <p>{reservation.customerContactNumber || 'N/A'}</p>
                        <p className="text-xs text-slate-500">{reservation.customerEmail || 'No email'}</p>
                      </div>
                    </TableCell>
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
                      ) : null}
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
