'use client'

// Reserve Item - opened from the dashboard's Quick Actions.
//
// A compact version of the Sales POS reservation flow: search the inventory,
// build a cart with the same quantity rules, enter the customer's details and
// confirm. It submits through createReservation(), the same request the POS
// "Reserve Order" button sends, so the API holds the stock and writes the
// stock log exactly as it does from Sales. It can never record a sale.
//
// Per-piece items are reserved by condition, at that condition's price, the
// same as the New sale window: the window reads the shelf itself when it
// opens and waits for it - it never falls back to the item's New price, which
// would put a Good or Fair piece on the ticket at the New price. Pieces with
// a price of their own are reserved one by one.
//
// Availability follows the POS: available = stock - reservedStock, and a line
// can never exceed it. Deleted and written-off items are not offered.

import { INPUT_LIMITS } from '@/lib/constants/limits'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWindowFocus } from '@/lib/client/useWindowFocus'
import { useConfirm } from '@/components/shared/ConfirmDialog'
import Link from 'next/link'
import { toast } from 'sonner'
import { Plus, X } from 'lucide-react'
import { apiFetch } from '@/lib/apiFetch'
import { useFitRows } from '@/lib/client/useFitRows'
import { GRADE_LABEL, GRADE_TONE, UNIT_GRADES, type UnitGrade } from '@/lib/inventory/units'
import {
  contactNumberProblem,
  createReservation,
  isValidContactNumber,
  isValidOptionalEmail,
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
  /** 'unit': reserved piece by piece, by condition, at each condition's price. */
  trackingMode?: 'unit' | 'quantity'
}

interface ShelfGrade { grade: UnitGrade; count: number; price: number }
interface ShelfEntry {
  grades: ShelfGrade[]
  /** Pieces with a price of their own, one by one, oldest first. */
  ownPieces?: Array<{ id: string; unitCode: string; grade: UnitGrade; price: number }>
}

/** Own-price pieces of one condition and price - one button. */
interface OwnGroup { grade: UnitGrade; price: number; pieces: Array<{ id: string; unitCode: string }> }

interface CartLine {
  /** Line key: item id, item id + condition, or item id + piece id. */
  id: string
  itemId: string
  name: string
  price: number
  quantity: number
  /** Most this line can hold (the condition's count, or the item's stock). */
  max: number
  /** What the line is: the condition, "Good · #00000012", or the item's condition. */
  label: string
  /** Per-piece items: the condition to hold. */
  grade?: UnitGrade
  /** A piece with its own price: exactly this piece, a line of one. */
  units?: Array<{ id: string }>
  fixed?: boolean
}

const currency = (value: number) =>
  value.toLocaleString('en-PH', { style: 'currency', currency: 'PHP', minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** Own-price pieces grouped by condition and price, best condition first. */
function ownGroupsOf(entry: ShelfEntry | undefined): OwnGroup[] {
  const groups: OwnGroup[] = []
  for (const p of entry?.ownPieces ?? []) {
    const g = groups.find((o) => o.grade === p.grade && o.price === p.price)
    if (g) g.pieces.push(p)
    else groups.push({ grade: p.grade, price: p.price, pieces: [p] })
  }
  return groups.sort((a, b) => UNIT_GRADES.indexOf(a.grade) - UNIT_GRADES.indexOf(b.grade) || b.price - a.price)
}

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
  const [shelf, setShelf] = useState<Record<string, ShelfEntry>>({})
  const [shelfStatus, setShelfStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const shelfRequest = useRef(0)
  const [fullName, setFullName] = useState('')
  const [contactNumber, setContactNumber] = useState('')
  const [email, setEmail] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [reservationCode, setReservationCode] = useState<string | null>(null)
  // As many products per page as the window has room for.
  const { ref: listRef, rows: PAGE_SIZE } = useFitRows()

  const loadShelf = useCallback(() => {
    const seq = ++shelfRequest.current
    setShelfStatus('loading')
    apiFetch('/api/inventory/units/summary')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { items?: Record<string, ShelfEntry> }) => {
        if (seq !== shelfRequest.current) return // a newer answer is on its way
        setShelf(d.items ?? {})
        setShelfStatus('ready')
      })
      .catch(() => { if (seq === shelfRequest.current) setShelfStatus('error') })
  }, [])

  // Fresh form, and fresh condition prices, every time the modal opens.
  useEffect(() => {
    if (!isOpen) return
    setSearch(''); setPage(1); setCart([]); setFullName(''); setContactNumber(''); setEmail('')
    setError(''); setReservationCode(null); setSubmitting(false)
    loadShelf()
  }, [isOpen, loadShelf])

  // Closing with unsaved work (Esc or ✕) asks first, in the app's own window.
  const { confirm: askConfirm, confirmDialog } = useConfirm()
  const requestClose = async () => {
    if (submitting) return
    if ((cart.length > 0 || fullName.trim() !== '' || contactNumber !== '') && !reservationCode) {
      const ok = await askConfirm({ title: 'Discard this reservation?', message: 'The items and customer details you entered will be cleared.', confirmLabel: 'Discard', cancelLabel: 'Keep editing', tone: 'danger' })
      if (!ok) return
    }
    onClose()
  }
  const requestCloseRef = useRef(requestClose)
  requestCloseRef.current = requestClose

  // Escape closes, except while the request is in flight.
  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !submitting) void requestCloseRef.current() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, submitting])

  // If live stock drops below what is in the cart (another counter sold it),
  // clamp the line rather than let the API refuse the whole reservation.
  useEffect(() => {
    setCart((current) => current.flatMap((line) => {
      const live = items.find((i) => i.id === line.itemId)
      if (!live || live.availableStock <= 0) return []
      const entry = shelf[line.itemId]
      if (line.fixed) {
        // An own-price piece that has left the shelf is gone from the cart.
        if (shelfStatus === 'ready' && !entry?.ownPieces?.some((p) => p.id === line.units?.[0]?.id)) return []
        return [line]
      }
      const others = current.filter((o) => o.itemId === line.itemId && o.id !== line.id).reduce((n, o) => n + o.quantity, 0)
      const g = line.grade ? entry?.grades.find((x) => x.grade === line.grade) : undefined
      if (line.grade && shelfStatus === 'ready' && !g) return []
      const max = g ? g.count : live.availableStock
      const room = Math.min(max, live.availableStock - others)
      if (room <= 0) return []
      return [{ ...line, max, price: g ? g.price : line.grade ? line.price : live.price, quantity: Math.min(line.quantity, room) }]
    }))
  }, [items, shelf, shelfStatus])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return items
      .filter((i) => !q || i.name.toLowerCase().includes(q) || i.categoryName.toLowerCase().includes(q))
      .sort((a, b) => (a.availableStock <= 0 ? 1 : 0) - (b.availableStock <= 0 ? 1 : 0) || a.name.localeCompare(b.name))
  }, [items, search])
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const pageSafe = Math.min(page, pageCount)
  const visible = filtered.slice((pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE)
  useEffect(() => { setPage(1) }, [search])

  const subtotal = cart.reduce((s, l) => s + l.price * l.quantity, 0)
  const units = cart.reduce((s, l) => s + l.quantity, 0)
  const contactInvalid = contactNumber.length > 0 && !isValidContactNumber(contactNumber)
  const emailInvalid = !isValidOptionalEmail(email)
  const canConfirm = cart.length > 0 && fullName.trim().length > 0 && isValidContactNumber(contactNumber) && !emailInvalid && !submitting
  // Shown under a greyed-out Confirm, so it is clear what is still needed.
  const missing = [
    cart.length === 0 && 'an item',
    !fullName.trim() && "the customer's name",
    !isValidContactNumber(contactNumber) && 'a valid phone number',
    emailInvalid && 'a valid email (or none)',
  ].filter(Boolean) as string[]

  // Focus moves into the window and Tab stays inside it.
  const panelRef = useRef<HTMLDivElement>(null)
  useWindowFocus(panelRef, isOpen)

  if (!isOpen) return null

  const inCartFor = (itemId: string) => cart.filter((l) => l.itemId === itemId).reduce((n, l) => n + l.quantity, 0)

  /** Adds one of a line, or returns why it could not. */
  const addLine = (line: Omit<CartLine, 'quantity'>, item: ReservableItem): string | null => {
    if (item.availableStock <= 0) return `${item.name} is out of available stock.`
    if (inCartFor(item.id) >= item.availableStock) return `Only ${item.availableStock} left of ${item.name}.`
    const existing = cart.find((l) => l.id === line.id)
    if (line.fixed && existing) return `Piece ${line.label} is already in the list.`
    if (existing && existing.quantity >= existing.max) return `Only ${existing.max} of ${item.name} (${line.label}) on the shelf.`
    setCart((current) => existing
      ? current.map((l) => (l.id === line.id ? { ...l, quantity: l.quantity + 1 } : l))
      : [...current, { ...line, quantity: 1 }])
    return null
  }

  const addItem = (item: ReservableItem) =>
    addLine({ id: item.id, itemId: item.id, name: item.name, price: item.price, max: item.availableStock, label: item.condition }, item)

  const addGrade = (item: ReservableItem, g: ShelfGrade) =>
    addLine({ id: `${item.id}:${g.grade}`, itemId: item.id, name: item.name, price: g.price, max: g.count, label: GRADE_LABEL[g.grade] ?? g.grade, grade: g.grade }, item)

  /** Adds the oldest piece of the group not yet in the list. */
  const addOwn = (item: ReservableItem, g: OwnGroup) => {
    const next = g.pieces.find((p) => !cart.some((l) => l.id === `${item.id}#${p.id}`))
    if (!next) return `All ${GRADE_LABEL[g.grade]} pieces at ${currency(g.price)} are in the list.`
    return addLine({
      id: `${item.id}#${next.id}`, itemId: item.id, name: item.name, price: g.price, max: 1,
      label: `${GRADE_LABEL[g.grade]} · #${next.unitCode}`, grade: undefined,
      units: [{ id: next.id }], fixed: true,
    }, item)
  }

  const report = (refusal: string | null) => setError(refusal ?? '')

  const setQty = (id: string, next: number) => {
    setError('')
    setCart((current) => current.flatMap((l) => {
      if (l.id !== id) return [l]
      if (next <= 0) return []
      const live = items.find((i) => i.id === l.itemId)
      const others = current.filter((o) => o.itemId === l.itemId && o.id !== id).reduce((n, o) => n + o.quantity, 0)
      if (next > l.max || next + others > (live?.availableStock ?? 0)) { setError(`Cannot exceed available stock for ${l.name}.`); return [l] }
      return [{ ...l, quantity: next }]
    }))
  }

  const confirm = async () => {
    if (!canConfirm) return
    setSubmitting(true)
    setError('')
    try {
      const result = await createReservation(
        cart.map((l) => ({ id: l.id, itemId: l.itemId, name: l.name, price: l.price, quantity: l.quantity, ...(l.grade ? { grade: l.grade } : {}), ...(l.units ? { units: l.units } : {}) })),
        { fullName, contactNumber, email }
      )
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

  const chip = 'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs text-slate-700 transition disabled:cursor-not-allowed disabled:opacity-40'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 md:pl-[calc(13rem+1rem)]" role="dialog" aria-modal="true" aria-labelledby="reserve-item-title">
      {confirmDialog}
      <div ref={panelRef} className={`flex max-h-[calc(100vh-2rem)] w-full flex-col overflow-hidden rounded-2xl bg-white shadow-2xl ${reservationCode !== null ? '' : 'lg:h-[calc(100vh-2rem)]'}`}>
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <div>
            <h2 id="reserve-item-title" className="text-lg font-semibold text-slate-900">Reserve item</h2>
            <p className="text-xs text-slate-500">Hold items for a customer. Stock is set aside until the reservation is collected or expires.</p>
          </div>
          <button type="button" onClick={() => void requestClose()} disabled={submitting} className="rounded-lg p-1 text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 disabled:opacity-40" title="Close" aria-label="Close">
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
          <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_400px] lg:overflow-hidden">
            {/* Products */}
            <div className="flex min-h-0 flex-col border-b border-slate-100 lg:border-b-0 lg:border-r">
              <div className="px-5 py-3">
                <input maxLength={INPUT_LIMITS.search}
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search products or categories"
                  autoFocus
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-blue-400 focus:outline-none"
                />
              </div>
              <div ref={listRef} className="min-h-0 flex-1 overflow-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 z-10 bg-slate-50 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-5 py-2 text-left">Product</th>
                      <th className="px-3 py-2 text-right">Available</th>
                      <th className="px-5 py-2 text-right">Reserve by condition</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {loading ? (
                      <tr><td colSpan={3} className="py-8 text-center text-sm text-slate-500">Loading products...</td></tr>
                    ) : visible.length === 0 ? (
                      <tr><td colSpan={3} className="py-8 text-center text-sm text-slate-500">{items.length === 0 ? 'No products in inventory.' : 'No products match your search.'}</td></tr>
                    ) : visible.map((item) => {
                      const out = item.availableStock <= 0
                      const perPiece = item.trackingMode === 'unit'
                      const grades = (shelf[item.id]?.grades ?? []).slice().sort((a, b) => UNIT_GRADES.indexOf(a.grade) - UNIT_GRADES.indexOf(b.grade))
                      const ownGroups = ownGroupsOf(shelf[item.id])
                      const ownCount = ownGroups.reduce((s, g) => s + g.pieces.length, 0)
                      const left = item.availableStock - inCartFor(item.id)
                      return (
                        <tr key={item.id} data-row className="hover:bg-slate-50/70">
                          <td className="px-5 py-2.5">
                            <p className="font-medium text-slate-900">
                              {item.name}
                              {item.isSingleItem && <span className="ml-1.5 rounded bg-violet-50 px-1 align-middle text-[10px] font-semibold text-violet-700">One-off</span>}
                            </p>
                            <p className="truncate text-xs text-slate-500">
                              {item.categoryName}
                              {/* Count-tracked items have one condition for the lot. */}
                              {!perPiece && grades.length === 0 && item.condition ? ` · ${item.condition}` : ''}
                              {item.conditionNotes ? ` · ${item.conditionNotes}` : ''}
                            </p>
                          </td>
                          <td className={`px-3 py-2.5 text-right text-xs tabular-nums ${out ? 'text-red-600' : 'text-slate-600'}`}>{out ? 'Out of stock' : item.availableStock}</td>
                          <td className="px-5 py-2.5">
                            <div className="flex flex-wrap justify-end gap-1">
                              {perPiece && shelfStatus !== 'ready' ? (
                                shelfStatus === 'error' ? (
                                  <button type="button" onClick={loadShelf}
                                    className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-blue-600 hover:bg-blue-50">
                                    Conditions didn&apos;t load · Retry
                                  </button>
                                ) : (
                                  <span className="flex items-center gap-1" aria-label="Loading conditions">
                                    <span className="h-6 w-24 animate-pulse rounded-md bg-slate-100" />
                                    <span className="h-6 w-20 animate-pulse rounded-md bg-slate-100" />
                                  </span>
                                )
                              ) : perPiece || grades.length > 0 ? (<>
                                {grades.map((g) => (
                                  <button
                                    key={g.grade}
                                    type="button"
                                    onClick={() => report(addGrade(item, g))}
                                    disabled={out || left <= 0 || submitting}
                                    title={`Reserve one ${GRADE_LABEL[g.grade]} piece · ${g.count} on the shelf`}
                                    className={`${chip} border-slate-200 bg-white hover:border-blue-300 hover:bg-blue-50`}
                                  >
                                    <span className={`h-1.5 w-1.5 rounded-full ${GRADE_TONE[g.grade]?.dot ?? 'bg-slate-400'}`} />
                                    {GRADE_LABEL[g.grade] ?? g.grade}
                                    <span className="font-semibold tabular-nums text-slate-900">{currency(g.price)}</span>
                                    <span className="rounded bg-slate-100 px-1 text-[10px] tabular-nums text-slate-500">{g.count}</span>
                                  </button>
                                ))}
                                {ownGroups.map((g) => {
                                  const inCart = g.pieces.filter((p) => cart.some((l) => l.id === `${item.id}#${p.id}`)).length
                                  const remaining = g.pieces.length - inCart
                                  return (
                                    <button
                                      key={`${g.grade}:${g.price}`}
                                      type="button"
                                      onClick={() => report(addOwn(item, g))}
                                      disabled={out || left <= 0 || remaining <= 0 || submitting}
                                      title={`Reserve one ${GRADE_LABEL[g.grade]} piece priced on its own · ${remaining} on the shelf`}
                                      className={`${chip} border-blue-200 bg-blue-50/40 hover:border-blue-300 hover:bg-blue-50`}
                                    >
                                      <span className={`h-1.5 w-1.5 rounded-full ${GRADE_TONE[g.grade]?.dot ?? 'bg-slate-400'}`} />
                                      {GRADE_LABEL[g.grade] ?? g.grade}
                                      <span className="font-semibold tabular-nums text-slate-900">{currency(g.price)}</span>
                                      <span className="text-[10px] font-semibold text-blue-600">own price</span>
                                      <span className="rounded bg-slate-100 px-1 text-[10px] tabular-nums text-slate-500">{remaining}</span>
                                    </button>
                                  )
                                })}
                                {grades.length === 0 && ownCount === 0 && <span className="text-xs text-slate-500">None on the shelf</span>}
                              </>) : (
                                <button
                                  type="button"
                                  onClick={() => report(addItem(item))}
                                  disabled={out || left <= 0 || submitting}
                                  className={`${chip} border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50`}
                                >
                                  <Plus aria-hidden className="h-3 w-3" />
                                  <span className="font-semibold tabular-nums text-slate-900">{currency(item.price)}</span>
                                </button>
                              )}
                            </div>
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
                  <div className="flex items-center gap-1">
                    <button type="button" onClick={() => setPage(pageSafe - 1)} disabled={pageSafe === 1} aria-label="Previous page" className="h-7 w-7 rounded-md border border-slate-200 disabled:opacity-40">‹</button>
                    <span className="px-2 tabular-nums">{pageSafe} / {pageCount}</span>
                    <button type="button" onClick={() => setPage(pageSafe + 1)} disabled={pageSafe === pageCount} aria-label="Next page" className="h-7 w-7 rounded-md border border-slate-200 disabled:opacity-40">›</button>
                  </div>
                </div>
              )}
            </div>

            {/* Cart + customer */}
            <div className="flex min-h-0 flex-col lg:overflow-y-auto">
              <div className="border-b border-slate-100 px-4 py-3">
                <p className="text-sm font-semibold text-slate-900">Items to reserve <span className="font-normal text-slate-500">({units})</span></p>
              </div>
              <div className="max-h-56 divide-y divide-slate-50 overflow-y-auto px-4 lg:max-h-none lg:min-h-0 lg:flex-1">
                {cart.length === 0 ? (
                  <p className="py-5 text-center text-xs text-slate-500">No items yet. Pick a condition from the list.</p>
                ) : cart.map((l) => {
                  const grade = (l.grade ?? l.label.split(' · ')[0]) as UnitGrade
                  return (
                    <div key={l.id} className="flex items-start gap-2 py-2.5">
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium leading-tight text-slate-900">{l.name}</p>
                        <p className="flex items-center gap-1 text-xs text-slate-500">
                          {GRADE_TONE[grade] && <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${GRADE_TONE[grade].dot}`} />}
                          <span className="truncate">{l.label} · {currency(l.price)}</span>
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <button type="button" onClick={() => setQty(l.id, l.quantity - 1)} disabled={submitting} aria-label={`Decrease ${l.name}`} className="flex h-5 w-5 items-center justify-center rounded border border-slate-200 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-40">−</button>
                        <span className="w-5 text-center text-xs font-medium text-slate-800">{l.quantity}</span>
                        <button type="button" onClick={() => setQty(l.id, l.quantity + 1)} disabled={submitting || l.quantity >= l.max} aria-label={`Increase ${l.name}`} className="flex h-5 w-5 items-center justify-center rounded border border-slate-200 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-40">+</button>
                      </div>
                      <p className="w-20 shrink-0 text-right text-xs font-semibold text-slate-900">{currency(l.price * l.quantity)}</p>
                      <button type="button" onClick={() => setQty(l.id, 0)} disabled={submitting} aria-label={`Remove ${l.name}`} className="shrink-0 text-slate-300 hover:text-slate-500 disabled:opacity-40">
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )
                })}
              </div>
              <div className="flex items-center justify-between border-t border-slate-100 px-4 py-2.5 text-sm">
                <span className="text-slate-600">Total</span>
                <span className="font-semibold text-slate-900">{currency(subtotal)}</span>
              </div>

              <div className="space-y-2.5 border-t border-slate-100 px-4 py-3">
                <p className="text-sm font-semibold text-slate-900">Reservation details</p>
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-600">Name <span className="font-semibold text-rose-500">*</span></label>
                  <input maxLength={INPUT_LIMITS.name} type="text" value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Customer name" disabled={submitting}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-blue-400 focus:outline-none disabled:opacity-60" />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-600">Phone <span className="font-semibold text-rose-500">*</span></label>
                  <input type="tel" inputMode="numeric" maxLength={11} value={contactNumber}
                    onChange={(e) => setContactNumber(e.target.value.replace(/\D/g, '').slice(0, 11))}
                    placeholder="09XXXXXXXXX" disabled={submitting}
                    className={`w-full rounded-lg border px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none disabled:opacity-60 ${contactInvalid ? 'border-rose-300 focus:border-rose-400' : 'border-slate-200 focus:border-blue-400'}`} />
                  {contactInvalid && <p className="mt-1 text-xs text-rose-500">{contactNumberProblem(contactNumber)}</p>}
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-600">Email <span className="font-normal text-slate-500">(Optional)</span></label>
                  <input maxLength={INPUT_LIMITS.email} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email address" disabled={submitting} aria-invalid={emailInvalid}
                    className={`w-full rounded-lg border px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none disabled:opacity-60 ${emailInvalid ? 'border-rose-300 focus:border-rose-400' : 'border-slate-200 focus:border-blue-400'}`} />
                  {emailInvalid && <p className="mt-1 text-xs text-rose-500">Enter a valid email address, or leave it empty</p>}
                </div>
              </div>

              {error && <p className="mx-4 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>}

              {!submitting && missing.length > 0 && (
                <p className="mx-4 text-xs text-slate-500">To confirm, add {missing.length > 1 ? missing.slice(0, -1).join(', ') + ' and ' + missing[missing.length - 1] : missing[0]}.</p>
              )}
              <div className="mt-auto flex gap-2 border-t border-slate-100 px-4 py-3">
                <button type="button" onClick={() => void requestClose()} disabled={submitting} className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-40">
                  Cancel
                </button>
                <button type="button" onClick={confirm} disabled={!canConfirm} className="flex-1 rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40">
                  {submitting ? 'Reserving…' : 'Confirm reservation'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
