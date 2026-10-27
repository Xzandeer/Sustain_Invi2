'use client'

// Reserve Item - opened from the dashboard's Quick Actions.
//
// A compact version of the Sales POS reservation flow: search the inventory,
// build a cart with the same quantity rules, enter the customer's details and
// confirm. It submits through createReservation(), the same request the POS
// "Reserve Order" button sends, so the API holds the stock and writes the
// stock log exactly as it does from Sales. It can never record a sale.
//
// Availability follows the POS: available = stock - reservedStock, and a line
// can never exceed it. Deleted and written-off items are not offered.

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { X } from 'lucide-react'
import {
  createReservation,
  isValidContactNumber,
} from '@/lib/reservations/createReservation'

export interface ReservableItem {
  id: string
  name: string
  categoryName: string
  price: number
  condition: string
  availableStock: number
  isSingleItem?: boolean
  conditionNotes?: string
}

interface CartLine {
  id: string
  name: string
  price: number
  quantity: number
  availableStock: number
  condition: string
}

const currency = (value: number) =>
  value.toLocaleString('en-PH', { style: 'currency', currency: 'PHP', minimumFractionDigits: 2, maximumFractionDigits: 2 })

const PAGE_SIZE = 8

export default function ReserveItemModal({
  isOpen,
  onClose,
  items,
  loading,
  onReserved,
}: {
  isOpen: boolean
  onClose: () => void
  /** Inventory the dashboard has already loaded - no second read. */
  items: ReservableItem[]
  loading?: boolean
  /** Called after the API confirms the reservation, so the dashboard can refresh. */
  onReserved: () => void
}) {
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [cart, setCart] = useState<CartLine[]>([])
  const [fullName, setFullName] = useState('')
  const [contactNumber, setContactNumber] = useState('')
  const [email, setEmail] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [reservationCode, setReservationCode] = useState<string | null>(null)

  // Fresh form every time the modal opens.
  useEffect(() => {
    if (!isOpen) return
    setSearch(''); setPage(1); setCart([]); setFullName(''); setContactNumber(''); setEmail('')
    setError(''); setReservationCode(null); setSubmitting(false)
  }, [isOpen])

  // Escape closes, except while the request is in flight.
  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !submitting) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, submitting, onClose])

  // If live stock drops below what is in the cart (another counter sold it),
  // clamp the line rather than let the API refuse the whole reservation.
  useEffect(() => {
    setCart((current) => current.flatMap((line) => {
      const live = items.find((i) => i.id === line.id)
      if (!live || live.availableStock <= 0) return []
      return [{ ...line, availableStock: live.availableStock, price: live.price, quantity: Math.min(line.quantity, live.availableStock) }]
    }))
  }, [items])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return items
      .filter((i) => !q || i.name.toLowerCase().includes(q) || i.categoryName.toLowerCase().includes(q))
      .sort((a, b) => (a.availableStock <= 0 ? 1 : 0) - (b.availableStock <= 0 ? 1 : 0) || a.name.localeCompare(b.name))
  }, [items, search])
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const visible = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
  useEffect(() => { setPage(1) }, [search])

  const subtotal = cart.reduce((s, l) => s + l.price * l.quantity, 0)
  const units = cart.reduce((s, l) => s + l.quantity, 0)
  const contactInvalid = contactNumber.length > 0 && !isValidContactNumber(contactNumber)
  const canConfirm = cart.length > 0 && fullName.trim().length > 0 && isValidContactNumber(contactNumber) && !submitting

  if (!isOpen) return null

  const add = (item: ReservableItem) => {
    setError('')
    if (item.availableStock <= 0) { setError(`${item.name} is out of available stock.`); return }
    const existing = cart.find((l) => l.id === item.id)
    if (existing && existing.quantity >= item.availableStock) {
      setError(`Only ${item.availableStock} left of ${item.name}.`); return
    }
    setCart((current) => existing
      ? current.map((l) => (l.id === item.id ? { ...l, quantity: l.quantity + 1 } : l))
      : [...current, { id: item.id, name: item.name, price: item.price, quantity: 1, availableStock: item.availableStock, condition: item.condition }])
  }

  const setQty = (id: string, next: number) => {
    setError('')
    setCart((current) => current.flatMap((l) => {
      if (l.id !== id) return [l]
      if (next <= 0) return []
      if (next > l.availableStock) { setError(`Cannot exceed available stock for ${l.name}.`); return [l] }
      return [{ ...l, quantity: next }]
    }))
  }

  const confirm = async () => {
    if (!canConfirm) return
    setSubmitting(true)
    setError('')
    try {
      const result = await createReservation(cart, { fullName, contactNumber, email })
      const doc = result.document
      setReservationCode(doc && doc.type === 'reservation' ? doc.reservationCode : '')
      toast.success('Reservation created successfully.')
      onReserved()
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to create reservation.'
      setError(message)
      toast.error(message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3 sm:p-4" role="dialog" aria-modal="true" aria-labelledby="reserve-item-title">
      <div className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <div>
            <h2 id="reserve-item-title" className="text-lg font-semibold text-slate-900">Reserve Item</h2>
            <p className="text-xs text-slate-500">Hold items for a customer. Stock is set aside until the reservation is collected or expires.</p>
          </div>
          <button type="button" onClick={onClose} disabled={submitting} className="rounded-lg p-1 text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 disabled:opacity-40" title="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        {reservationCode !== null ? (
          /* Success */
          <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
            <p className="text-sm font-semibold uppercase tracking-wide text-emerald-600">Reservation created</p>
            {reservationCode && <p className="text-2xl font-bold text-slate-900">{reservationCode}</p>}
            <p className="max-w-sm text-sm text-slate-500">
              The items are now held for {fullName.trim()}. Print the reservation ticket or collect it from the Reservations page.
            </p>
            <div className="mt-2 flex flex-wrap justify-center gap-2">
              <Link href="/reservations" className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50">
                Open Reservations
              </Link>
              <button type="button" onClick={onClose} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-700">
                Done
              </button>
            </div>
          </div>
        ) : (
          <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_340px] lg:overflow-hidden">
            {/* Products */}
            <div className="flex min-h-0 flex-col border-b border-slate-100 lg:border-b-0 lg:border-r">
              <div className="px-5 py-3">
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search products or categories"
                  autoFocus
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-blue-400 focus:outline-none"
                />
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 z-10 bg-slate-50 text-xs font-medium text-slate-500">
                    <tr>
                      <th className="px-5 py-2.5 text-left">Product</th>
                      <th className="hidden px-3 py-2.5 text-left sm:table-cell">Category</th>
                      <th className="px-3 py-2.5 text-right">Price</th>
                      <th className="px-3 py-2.5 text-right">Available</th>
                      <th className="px-5 py-2.5 text-center">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {loading ? (
                      <tr><td colSpan={5} className="py-8 text-center text-sm text-slate-400">Loading products...</td></tr>
                    ) : visible.length === 0 ? (
                      <tr><td colSpan={5} className="py-8 text-center text-sm text-slate-400">{items.length === 0 ? 'No products in inventory.' : 'No products match your search.'}</td></tr>
                    ) : visible.map((item) => {
                      const out = item.availableStock <= 0
                      const inCart = cart.find((l) => l.id === item.id)?.quantity ?? 0
                      return (
                        <tr key={item.id} className="hover:bg-slate-50">
                          <td className="px-5 py-2.5">
                            <p className="font-medium text-slate-900">
                              {item.name}
                              {item.isSingleItem && <span className="ml-1.5 rounded-full bg-blue-50 px-1.5 py-0.5 align-middle text-[10px] font-semibold text-blue-700">Single</span>}
                            </p>
                            <p className="text-xs text-slate-400">{item.condition}{item.conditionNotes ? ` · ${item.conditionNotes}` : ''}</p>
                          </td>
                          <td className="hidden px-3 py-2.5 text-xs text-slate-500 sm:table-cell">{item.categoryName}</td>
                          <td className="px-3 py-2.5 text-right text-xs font-medium text-slate-800">{currency(item.price)}</td>
                          <td className={`px-3 py-2.5 text-right text-xs ${out ? 'text-red-600' : 'text-slate-600'}`}>{out ? 'Out of stock' : item.availableStock}</td>
                          <td className="px-5 py-2.5 text-center">
                            <button
                              type="button"
                              onClick={() => add(item)}
                              disabled={out || inCart >= item.availableStock || submitting}
                              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 transition hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              {inCart > 0 ? `Add (${inCart})` : 'Add'}
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              {pageCount > 1 && (
                <div className="flex items-center justify-between border-t border-slate-100 px-5 py-2 text-xs text-slate-500">
                  <span>{filtered.length} products</span>
                  <div className="flex items-center gap-2">
                    <button type="button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} className="rounded border border-slate-200 px-2 py-1 disabled:opacity-40">Prev</button>
                    <span>{page} / {pageCount}</span>
                    <button type="button" onClick={() => setPage((p) => Math.min(pageCount, p + 1))} disabled={page === pageCount} className="rounded border border-slate-200 px-2 py-1 disabled:opacity-40">Next</button>
                  </div>
                </div>
              )}
            </div>

            {/* Cart + customer */}
            <div className="flex min-h-0 flex-col lg:overflow-y-auto">
              <div className="border-b border-slate-100 px-4 py-3">
                <p className="text-sm font-semibold text-slate-900">Items to reserve <span className="font-normal text-slate-400">({units})</span></p>
              </div>
              <div className="max-h-56 divide-y divide-slate-50 overflow-y-auto px-4">
                {cart.length === 0 ? (
                  <p className="py-5 text-center text-xs text-slate-400">No items yet. Add products from the list.</p>
                ) : cart.map((l) => (
                  <div key={l.id} className="flex items-start gap-2 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium leading-tight text-slate-900">{l.name}</p>
                      <p className="text-xs text-slate-400">{l.condition} · {currency(l.price)}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <button type="button" onClick={() => setQty(l.id, l.quantity - 1)} disabled={submitting} aria-label={`Decrease ${l.name}`} className="flex h-5 w-5 items-center justify-center rounded border border-slate-200 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-40">−</button>
                      <span className="w-5 text-center text-xs font-medium text-slate-800">{l.quantity}</span>
                      <button type="button" onClick={() => setQty(l.id, l.quantity + 1)} disabled={submitting || l.quantity >= l.availableStock} aria-label={`Increase ${l.name}`} className="flex h-5 w-5 items-center justify-center rounded border border-slate-200 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-40">+</button>
                    </div>
                    <p className="w-20 shrink-0 text-right text-xs font-semibold text-slate-900">{currency(l.price * l.quantity)}</p>
                    <button type="button" onClick={() => setQty(l.id, 0)} disabled={submitting} aria-label={`Remove ${l.name}`} className="shrink-0 text-slate-300 hover:text-slate-500 disabled:opacity-40">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-between border-t border-slate-100 px-4 py-2.5 text-sm">
                <span className="text-slate-600">Total</span>
                <span className="font-semibold text-slate-900">{currency(subtotal)}</span>
              </div>

              <div className="space-y-2.5 border-t border-slate-100 px-4 py-3">
                <p className="text-sm font-semibold text-slate-900">Reservation Details</p>
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-600">Name <span className="font-semibold text-rose-500">*</span></label>
                  <input type="text" value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Customer name" disabled={submitting}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-blue-400 focus:outline-none disabled:opacity-60" />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-600">Phone <span className="font-semibold text-rose-500">*</span></label>
                  <input type="tel" inputMode="numeric" maxLength={11} value={contactNumber}
                    onChange={(e) => setContactNumber(e.target.value.replace(/\D/g, '').slice(0, 11))}
                    placeholder="09XXXXXXXXX" disabled={submitting}
                    className={`w-full rounded-lg border px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none disabled:opacity-60 ${contactInvalid ? 'border-rose-300 focus:border-rose-400' : 'border-slate-200 focus:border-blue-400'}`} />
                  {contactInvalid && <p className="mt-1 text-xs text-rose-500">Must be 11 digits ({contactNumber.length}/11)</p>}
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-600">Email <span className="font-normal text-slate-400">(Optional)</span></label>
                  <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email address" disabled={submitting}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-blue-400 focus:outline-none disabled:opacity-60" />
                </div>
              </div>

              {error && <p className="mx-4 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>}

              <div className="mt-auto flex gap-2 border-t border-slate-100 px-4 py-3">
                <button type="button" onClick={onClose} disabled={submitting} className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-40">
                  Cancel
                </button>
                <button type="button" onClick={confirm} disabled={!canConfirm} className="flex-1 rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40">
                  {submitting ? 'Reserving…' : 'Confirm Reservation'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
