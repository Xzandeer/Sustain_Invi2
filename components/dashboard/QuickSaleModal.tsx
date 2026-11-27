'use client'

// New sale - opened from the dashboard's Quick Actions.
//
// The Sales POS in a window: search or scan, a cart with the same rules, a
// discount, and checkout. Customer details are only taken for reservations. It sends the same POST /api/sales request
// as the Sales page, so stock, piece status, stock logs and the receipt are
// written exactly as they are there.
//
// Pieces tracked one by one (lib/inventory/units.ts) are sold by condition:
// each condition on the shelf is its own Add button at its own price, and the
// server picks the oldest piece of it. A scanned piece label adds that exact
// piece. Pieces with a price of their own are offered by price too: a click
// adds the oldest one not yet in the cart. Counted-only items add one at a
// time, as on the POS.

import { INPUT_LIMITS } from '@/lib/constants/limits'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWindowFocus } from '@/lib/client/useWindowFocus'
import { useConfirm } from '@/components/shared/ConfirmDialog'
import Link from 'next/link'
import { toast } from 'sonner'
import { Loader2, Minus, Plus, Printer, ScanLine, Search, ShoppingCart, X } from 'lucide-react'
import { apiFetch } from '@/lib/apiFetch'
import { useFitRows } from '@/lib/client/useFitRows'
import { forgetReads } from '@/lib/client/readCache'
import { auth } from '@/lib/firebase'
import { openReceiptPrintWindow } from '@/lib/transactions/receiptPrint'
import type { CompletedTransactionDocument, SaleReceiptDocument } from '@/lib/transactions/transactionDocuments'
import { GRADE_LABEL, GRADE_TONE, UNIT_GRADES, type UnitGrade } from '@/lib/inventory/units'
import { limitDiscountInput } from '@/lib/sales/discount'

export interface SellableItem {
  id: string
  name: string
  categoryName: string
  price: number
  condition: string
  availableStock: number
  isSingleItem?: boolean
  conditionNotes?: string
  /** 'unit': sold piece by piece, by condition, at each condition's price. */
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

interface ScannedUnit { id: string; unitCode: string; grade: string; price: number; ownPrice?: boolean }

interface CartLine {
  /** Line key: item id, item id + condition, or item id + piece id. */
  key: string
  itemId: string
  name: string
  price: number
  quantity: number
  /** Most this line can hold. */
  max: number
  label: string
  grade?: string
  /** Scanned pieces on the line; the rest sell oldest first. */
  units?: ScannedUnit[]
  /** A piece with its own price - always a line of one. */
  fixed?: boolean
}

const currency = (value: number) =>
  value.toLocaleString('en-PH', { style: 'currency', currency: 'PHP', minimumFractionDigits: 2, maximumFractionDigits: 2 })

const SCAN_GAP_MS = 100

export default function QuickSaleModal({
  isOpen,
  onClose,
  items,
  loading,
  initialCode,
  onSold,
}: {
  isOpen: boolean
  onClose: () => void
  /** Inventory the dashboard already loaded. */
  items: SellableItem[]
  loading?: boolean
  /** A code scanned before the window opened (camera scan), added on open. */
  initialCode?: string | null
  /** Called after the API confirms the sale, so the dashboard can refresh. */
  onSold: () => void
}) {
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [cart, setCart] = useState<CartLine[]>([])
  const [shelf, setShelf] = useState<Record<string, ShelfEntry>>({})
  // Condition prices: per-piece items wait for these - they never fall back
  // to the item's New price (that sold Good or Fair pieces at the New price).
  const [shelfStatus, setShelfStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const shelfRequest = useRef(0)
  // Discount as pesos or a percentage of the subtotal, as on the Sales page.
  const [discountMode, setDiscountMode] = useState<'peso' | 'percent'>('peso')
  const [discountInput, setDiscountInput] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [looking, setLooking] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState<SaleReceiptDocument | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  // As many products per page as the window has room for.
  const { ref: listRef, rows: PAGE_SIZE } = useFitRows()

  const reset = useCallback(() => {
    setSearch(''); setPage(1); setCart([]); setDiscountMode('peso'); setDiscountInput('')
    setError(''); setDone(null); setSubmitting(false)
  }, [])

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

  // Fresh form, and fresh shelf prices, every time it opens.
  useEffect(() => {
    if (!isOpen) return
    reset()
    loadShelf()
  }, [isOpen, reset, loadShelf])

  // While open, scans belong to this window, not the page-wide listener that
  // would take the cashier off to the Sales page.
  useEffect(() => {
    if (!isOpen) return
    document.body.dataset.localScan = '1'
    return () => { delete document.body.dataset.localScan }
  }, [isOpen])

  // ── Adding to the cart ───────────────────────────────────────────────────

  const inCartFor = (itemId: string, lines = cart) =>
    lines.filter((l) => l.itemId === itemId).reduce((s, l) => s + l.quantity, 0)

  /** Adds one of a line, or returns why it could not. */
  const addLine = (line: Omit<CartLine, 'quantity'>, itemAvailable: number): string | null => {
    const existing = cart.find((l) => l.key === line.key)
    if (line.fixed && existing) return `Piece ${line.label} is already in the cart.`
    if (inCartFor(line.itemId) >= itemAvailable) return `No more of ${line.name} available.`
    if (existing && existing.quantity >= existing.max) return `Only ${existing.max} of ${line.name} (${line.label}) on the shelf.`
    setCart((current) => existing
      ? current.map((l) => (l.key === line.key ? { ...l, quantity: l.quantity + 1, units: line.units ? [...(l.units ?? []), ...line.units] : l.units } : l))
      : [...current, { ...line, quantity: 1 }])
    return null
  }

  const addItem = (item: SellableItem) => addLine(
    { key: item.id, itemId: item.id, name: item.name, price: item.price, max: item.availableStock, label: item.condition },
    item.availableStock,
  )

  const addGrade = (item: SellableItem, g: ShelfGrade) => addLine(
    { key: `${item.id}:${g.grade}`, itemId: item.id, name: item.name, price: g.price, max: g.count, label: GRADE_LABEL[g.grade] ?? g.grade, grade: g.grade },
    item.availableStock,
  )

  /** Adds the oldest piece of the group not yet in the cart. */
  const addOwn = (item: SellableItem, g: OwnGroup) => {
    const next = g.pieces.find((p) => !cart.some((l) => l.key === `${item.id}#${p.id}`))
    if (!next) return `All ${GRADE_LABEL[g.grade]} pieces at ${currency(g.price)} are in the cart.`
    return addLine({
      key: `${item.id}#${next.id}`, itemId: item.id, name: item.name, price: g.price, max: 1,
      label: `${GRADE_LABEL[g.grade]} · #${next.unitCode}`,
      units: [{ id: next.id, unitCode: next.unitCode, grade: g.grade, price: g.price, ownPrice: true }], fixed: true,
    }, item.availableStock)
  }

  const report = (refusal: string | null) => { setError(refusal ?? ''); if (refusal) toast.error(refusal) }

  // ── Scanning (USB scanner, typed code, or the camera before opening) ──────

  const lookUp = useCallback(async (raw: string) => {
    const code = raw.replace(/\D/g, '')
    if (code.length < 4) return false
    setLooking(true)
    try {
      const res = await apiFetch(`/api/inventory/barcodes?code=${encodeURIComponent(code)}`)
      const payload = (await res.json()) as {
        item?: { id: string; name: string; price: number; condition: string; availableStock: number }
        unit?: ScannedUnit
        grades?: ShelfGrade[]
        error?: string
      }
      if (!res.ok || !payload.item) { report(payload.error || `No item found for code ${code}.`); return true }
      const found = payload.item
      const known = items.find((i) => i.id === found.id)
      const available = known?.availableStock ?? found.availableStock
      const item: SellableItem = known ?? { id: found.id, name: found.name, categoryName: '', price: found.price, condition: found.condition, availableStock: available }
      let refusal: string | null
      if (payload.unit) {
        const u = payload.unit
        refusal = u.ownPrice
          ? addLine({ key: `${item.id}#${u.id}`, itemId: item.id, name: item.name, price: u.price, max: 1, label: `#${u.unitCode}`, units: [u], fixed: true }, available)
          : addLine({ key: `${item.id}:${u.grade}`, itemId: item.id, name: item.name, price: u.price, max: shelf[item.id]?.grades.find((g) => g.grade === u.grade)?.count ?? 1, label: GRADE_LABEL[u.grade as UnitGrade] ?? u.grade, grade: u.grade, units: [u] }, available)
      } else if (payload.grades && payload.grades.length > 1) {
        setSearch(item.name)
        toast.message(`${item.name} comes in ${payload.grades.length} conditions. Pick one below.`)
        return true
      } else if (payload.grades && payload.grades.length === 1) {
        refusal = addGrade(item, payload.grades[0])
      } else {
        refusal = addItem(item)
      }
      report(refusal)
      if (!refusal) { toast.success(`${item.name} added.`); setSearch('') }
      return true
    } catch {
      report('Could not look up that code.')
      return true
    } finally {
      setLooking(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, shelf, cart])

  const lookUpRef = useRef(lookUp)
  useEffect(() => { lookUpRef.current = lookUp })

  // The camera scan that opened the window.
  const initialDone = useRef<string | null>(null)
  useEffect(() => {
    if (!isOpen || !initialCode || initialDone.current === initialCode) return
    initialDone.current = initialCode
    void lookUpRef.current(initialCode)
  }, [isOpen, initialCode])
  useEffect(() => { if (!isOpen) initialDone.current = null }, [isOpen])

  // A USB scanner types fast and ends with Enter. Caught here wherever focus
  // is, except text fields; the search box handles its own Enter.
  useEffect(() => {
    if (!isOpen || done) return
    let buffer = ''
    let last = 0
    const onKey = (e: KeyboardEvent) => {
      const active = document.activeElement as HTMLElement | null
      if (active === searchRef.current) return
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return
      const now = Date.now()
      if (e.key === 'Enter') {
        const code = buffer
        buffer = ''
        if (code.length >= 4 && now - last <= SCAN_GAP_MS) {
          e.preventDefault(); e.stopPropagation()
          void lookUpRef.current(code)
        }
        return
      }
      if (e.key.length === 1) {
        if (now - last > SCAN_GAP_MS) buffer = ''
        buffer += e.key
        last = now
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [isOpen, done])

  // Closing with unsaved work (Esc or ✕) asks first, in the app's own window.
  const { confirm, confirmDialog } = useConfirm()
  const requestClose = async () => {
    if (submitting) return
    if (cart.length > 0 && !done) {
      const ok = await confirm({ title: 'Discard this sale?', message: 'The items in the cart will be removed.', confirmLabel: 'Discard', cancelLabel: 'Keep selling', tone: 'danger' })
      if (!ok) return
    }
    onClose()
  }
  const requestCloseRef = useRef(requestClose)
  requestCloseRef.current = requestClose

  // Escape closes, except mid-checkout.
  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !submitting) void requestCloseRef.current() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, submitting])

  // Live stock fell (another counter sold it): trim the cart rather than let
  // the API refuse the whole sale.
  useEffect(() => {
    setCart((current) => {
      let changed = false
      const next = current.flatMap((l) => {
        const live = items.find((i) => i.id === l.itemId)
        if (!live) return [l]
        const others = current.filter((o) => o.itemId === l.itemId && o.key !== l.key).reduce((s, o) => s + o.quantity, 0)
        const room = Math.max(0, live.availableStock - others)
        if (l.quantity <= room) return [l]
        changed = true
        return room > 0 ? [{ ...l, quantity: room, units: l.units?.slice(0, room) }] : []
      })
      return changed ? next : current
    })
  }, [items])

  // ── Product list ─────────────────────────────────────────────────────────

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return items
      .filter((i) => !q || i.name.toLowerCase().includes(q) || i.categoryName.toLowerCase().includes(q))
      .sort((a, b) => (a.availableStock <= 0 ? 1 : 0) - (b.availableStock <= 0 ? 1 : 0) || a.name.localeCompare(b.name))
  }, [items, search])
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const pageSafe = Math.min(page, pageCount)
  const visible = filtered.slice((pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE)

  const subtotal = cart.reduce((s, l) => s + l.price * l.quantity, 0)
  // A percentage follows the subtotal; never more than the subtotal.
  // Rounded to the centavo, as the server rounds it, so ₱499.99999 off ₱500
  // is refused here, not only after Complete sale.
  const requestedDiscount = Math.round(Math.max(0,
    discountMode === 'percent' ? (subtotal * (Number(discountInput) || 0)) / 100 : Number(discountInput) || 0) * 100) / 100
  const discount = Math.min(subtotal, requestedDiscount)
  const total = Math.max(0, subtotal - discount)
  // A discount that would leave nothing to pay is refused, not quietly capped.
  const discountTooBig = cart.length > 0 && requestedDiscount > 0 && requestedDiscount >= Math.round(subtotal * 100) / 100
  const pieces = cart.reduce((s, l) => s + l.quantity, 0)

  const setQty = (key: string, next: number) => {
    setError('')
    setCart((current) => current.flatMap((l) => {
      if (l.key !== key) return [l]
      if (next <= 0) return []
      if (l.fixed && next > 1) return [l]
      const item = items.find((i) => i.id === l.itemId)
      const others = current.filter((o) => o.itemId === l.itemId && o.key !== key).reduce((s, o) => s + o.quantity, 0)
      const room = Math.min(l.max, (item?.availableStock ?? l.max) - others)
      if (next > room) { setError(`Cannot exceed available stock for ${l.name}.`); return [l] }
      return [{ ...l, quantity: next, units: l.units?.slice(0, next) }]
    }))
  }

  // ── Checkout: the same request the Sales page sends ──────────────────────

  const checkout = async () => {
    if (cart.length === 0 || submitting || discountTooBig) return
    setSubmitting(true)
    setError('')
    try {
      const response = await apiFetch('/api/sales', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: cart.map((l) => ({
            itemId: l.itemId,
            quantity: l.quantity,
            ...(l.grade ? { grade: l.grade } : {}),
            ...(l.units?.length ? { unitIds: l.units.map((u) => u.id) } : {}),
          })),
          // The peso discount; the server checks it against the subtotal.
          discount: Math.round(discount * 100) / 100,
          // A walk-in sale: customer details are only taken for reservations.
          customerDetails: { fullName: '', email: '', contactNumber: '' },
          processedBy: {
            uid: auth.currentUser?.uid ?? '',
            email: auth.currentUser?.email ?? '',
            name: auth.currentUser?.displayName ?? auth.currentUser?.email ?? '',
          },
        }),
      })
      const result = (await response.json()) as { error?: string; document?: CompletedTransactionDocument }
      if (!response.ok) throw new Error(result.error || 'Failed to complete sale.')
      forgetReads('sales:') // the Dashboard's refresh reads the new sale
      const doc = result.document?.type === 'sale' ? result.document : null
      setDone(doc)
      if (!doc) onClose()
      toast.success('Sale completed.')
      onSold()
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to complete sale.'
      setError(message)
      toast.error(message)
    } finally {
      setSubmitting(false)
    }
  }

  // Focus moves into the window and Tab stays inside it.
  const panelRef = useRef<HTMLDivElement>(null)
  useWindowFocus(panelRef, isOpen)

  if (!isOpen) return null

  const input = 'w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-blue-400 focus:outline-none disabled:opacity-60'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 md:pl-[calc(13rem+1rem)]" role="dialog" aria-modal="true" aria-labelledby="quick-sale-title">
      {confirmDialog}
      <div ref={panelRef} className={`flex max-h-[calc(100vh-2rem)] w-full flex-col overflow-hidden rounded-2xl bg-white shadow-2xl ${done ? '' : 'lg:h-[calc(100vh-2rem)]'}`}>
        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-3.5">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-600 text-white"><ShoppingCart aria-hidden className="h-[18px] w-[18px]" /></span>
            <div>
              <h2 id="quick-sale-title" className="text-base font-semibold text-slate-900">New sale</h2>
              <p className="text-xs text-slate-500">Search or scan items, then check out. Same as the Sales page.</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/sales" className="hidden rounded-lg px-2.5 py-1.5 text-xs font-medium text-blue-600 hover:bg-blue-50 sm:block">Open Sales page</Link>
            <button type="button" onClick={() => void requestClose()} disabled={submitting} className="rounded-lg p-1.5 text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 disabled:opacity-40" aria-label="Close">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {done ? (
          /* Sale done */
          <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
            <p className="text-xs font-semibold uppercase tracking-wider text-emerald-600">Sale completed</p>
            <p className="text-2xl font-bold text-slate-900">{done.receiptNumber}</p>
            <p className="text-sm text-slate-500">{currency(done.totalAmount)} · {done.items.length} line{done.items.length === 1 ? '' : 's'}</p>
            <div className="mt-2 flex flex-wrap justify-center gap-2">
              <button type="button" onClick={() => openReceiptPrintWindow(done)} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50">
                <Printer aria-hidden className="h-4 w-4" /> Print receipt
              </button>
              <button type="button" onClick={() => { reset(); loadShelf() }} className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50">
                Next sale
              </button>
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
                <div className="relative">
                  <Search aria-hidden className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                  <input maxLength={INPUT_LIMITS.search}
                    ref={searchRef}
                    type="search"
                    value={search}
                    onChange={(e) => { setSearch(e.target.value); setPage(1) }}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter') return
                      e.preventDefault()
                      const q = search.trim()
                      if (/^\d{4,}$/.test(q)) void lookUp(q)
                    }}
                    placeholder="Search products, or scan / type an item code and press Enter"
                    autoFocus
                    className={`${input} pl-9 pr-9`}
                  />
                  {looking ? <Loader2 aria-hidden className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-slate-500" />
                    : <ScanLine aria-hidden className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-300" />}
                </div>
              </div>
              <div ref={listRef} className="min-h-0 flex-1 overflow-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 z-10 bg-slate-50 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-5 py-2 text-left">Product</th>
                      <th className="px-3 py-2 text-right">Available</th>
                      <th className="px-5 py-2 text-right">Add to sale</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {loading ? (
                      <tr><td colSpan={3} className="py-8 text-center text-sm text-slate-500">Loading products…</td></tr>
                    ) : visible.length === 0 ? (
                      <tr><td colSpan={3} className="py-8 text-center text-sm text-slate-500">{items.length === 0 ? 'No products in inventory.' : 'No products match your search.'}</td></tr>
                    ) : visible.map((item) => {
                      const out = item.availableStock <= 0
                      const perPiece = item.trackingMode === 'unit'
                      const grades = (shelf[item.id]?.grades ?? []).slice().sort((a, b) => UNIT_GRADES.indexOf(a.grade) - UNIT_GRADES.indexOf(b.grade))
                      const ownGroups: OwnGroup[] = []
                      for (const p of shelf[item.id]?.ownPieces ?? []) {
                        const g = ownGroups.find((o) => o.grade === p.grade && o.price === p.price)
                        if (g) g.pieces.push(p)
                        else ownGroups.push({ grade: p.grade, price: p.price, pieces: [p] })
                      }
                      ownGroups.sort((a, b) => UNIT_GRADES.indexOf(a.grade) - UNIT_GRADES.indexOf(b.grade) || b.price - a.price)
                      const ownCount = ownGroups.reduce((s, g) => s + g.pieces.length, 0)
                      const left = item.availableStock - inCartFor(item.id)
                      return (
                        <tr key={item.id} data-row className="hover:bg-slate-50/70">
                          <td className="px-5 py-2.5">
                            <p className="font-medium text-slate-900">
                              {item.name}
                              {item.isSingleItem && <span className="ml-1.5 rounded bg-violet-50 px-1 align-middle text-[10px] font-semibold text-violet-700">One-off</span>}
                            </p>
                            <p className="truncate text-xs text-slate-500">{item.categoryName}{item.conditionNotes ? ` · ${item.conditionNotes}` : ''}</p>
                          </td>
                          <td className={`px-3 py-2.5 text-right text-xs tabular-nums ${out ? 'text-red-600' : 'text-slate-600'}`}>{out ? 'Out of stock' : item.availableStock}</td>
                          <td className="px-5 py-2.5">
                            <div className="flex flex-wrap justify-end gap-1">
                              {perPiece && shelfStatus !== 'ready' ? (
                                shelfStatus === 'error' ? (
                                  <button type="button" onClick={loadShelf}
                                    className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-blue-600 hover:bg-blue-50">
                                    Prices didn&apos;t load · Retry
                                  </button>
                                ) : (
                                  <span className="flex items-center gap-1" aria-label="Loading prices">
                                    <span className="h-6 w-24 animate-pulse rounded-md bg-slate-100" />
                                    <span className="h-6 w-20 animate-pulse rounded-md bg-slate-100" />
                                  </span>
                                )
                              ) : perPiece ? (<>
                                {grades.map((g) => (
                                  <button
                                    key={g.grade}
                                    type="button"
                                    onClick={() => report(addGrade(item, g))}
                                    disabled={out || left <= 0 || submitting}
                                    title={`Add one ${GRADE_LABEL[g.grade]} piece · ${g.count} on the shelf`}
                                    className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 transition hover:border-blue-300 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-40"
                                  >
                                    <span className={`h-1.5 w-1.5 rounded-full ${GRADE_TONE[g.grade]?.dot ?? 'bg-slate-400'}`} />
                                    {GRADE_LABEL[g.grade] ?? g.grade}
                                    <span className="font-semibold tabular-nums text-slate-900">{currency(g.price)}</span>
                                    <span className="rounded bg-slate-100 px-1 text-[10px] tabular-nums text-slate-500">{g.count}</span>
                                  </button>
                                ))}
                                {ownGroups.map((g) => {
                                  const inCart = g.pieces.filter((p) => cart.some((l) => l.key === `${item.id}#${p.id}`)).length
                                  const remaining = g.pieces.length - inCart
                                  return (
                                    <button
                                      key={`${g.grade}:${g.price}`}
                                      type="button"
                                      onClick={() => report(addOwn(item, g))}
                                      disabled={out || left <= 0 || remaining <= 0 || submitting}
                                      title={`Add one ${GRADE_LABEL[g.grade]} piece priced on its own · ${remaining} on the shelf`}
                                      className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 transition hover:border-blue-300 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-40"
                                    >
                                      <span className={`h-1.5 w-1.5 rounded-full ${GRADE_TONE[g.grade]?.dot ?? 'bg-slate-400'}`} />
                                      {GRADE_LABEL[g.grade] ?? g.grade}
                                      <span className="font-semibold tabular-nums text-slate-900">{currency(g.price)}</span>
                                      <span className="rounded bg-slate-100 px-1 text-[10px] tabular-nums text-slate-500">{remaining}</span>
                                    </button>
                                  )
                                })}
                                {grades.length === 0 && ownCount === 0 && <span className="text-xs text-slate-500">None on the shelf</span>}
                              </>) : grades.length > 0 ? grades.map((g) => (
                                <button
                                  key={g.grade}
                                  type="button"
                                  onClick={() => report(addGrade(item, g))}
                                  disabled={out || left <= 0 || submitting}
                                  title={`${GRADE_LABEL[g.grade]} · ${g.count} on the shelf`}
                                  className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 transition hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                                >
                                  <span className={`h-1.5 w-1.5 rounded-full ${GRADE_TONE[g.grade]?.dot ?? 'bg-slate-400'}`} />
                                  {g.grade}
                                  <span className="font-semibold tabular-nums text-slate-900">{currency(g.price)}</span>
                                </button>
                              )) : (
                                <button
                                  type="button"
                                  onClick={() => report(addItem(item))}
                                  disabled={out || left <= 0 || submitting}
                                  className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 transition hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
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

            {/* Cart, discount, checkout */}
            <div className="flex min-h-0 flex-col bg-slate-50/50 lg:overflow-y-auto">
              <div className="flex items-baseline justify-between border-b border-slate-100 px-4 py-3">
                <p className="text-sm font-semibold text-slate-900">Cart</p>
                <span className="text-xs tabular-nums text-slate-500">{pieces} piece{pieces === 1 ? '' : 's'}</span>
              </div>
              <div className="max-h-64 divide-y divide-slate-100 overflow-y-auto px-4 lg:max-h-none lg:min-h-0 lg:flex-1">
                {cart.length === 0 ? (
                  <p className="py-6 text-center text-xs text-slate-500">Cart is empty. Add items from the list or scan a label.</p>
                ) : cart.map((l) => (
                  <div key={l.key} className="flex items-center gap-2 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium leading-tight text-slate-900">{l.name}</p>
                      <p className="text-xs text-slate-500">{l.label} · {currency(l.price)}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <button type="button" onClick={() => setQty(l.key, l.quantity - 1)} disabled={submitting} aria-label={`Decrease ${l.name}`} className="flex h-6 w-6 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-40"><Minus className="h-3 w-3" /></button>
                      <span className="w-6 text-center text-xs font-semibold tabular-nums text-slate-800">{l.quantity}</span>
                      <button type="button" onClick={() => setQty(l.key, l.quantity + 1)} disabled={submitting || l.fixed || l.quantity >= l.max} aria-label={`Increase ${l.name}`} className="flex h-6 w-6 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-40"><Plus className="h-3 w-3" /></button>
                    </div>
                    <p className="w-20 shrink-0 text-right text-[13px] font-semibold tabular-nums text-slate-900">{currency(l.price * l.quantity)}</p>
                    <button type="button" onClick={() => setQty(l.key, 0)} disabled={submitting} aria-label={`Remove ${l.name}`} className="shrink-0 text-slate-300 hover:text-slate-500 disabled:opacity-40"><X className="h-3.5 w-3.5" /></button>
                  </div>
                ))}
              </div>

              {error && <p className="mx-4 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>}

              <div className="mt-auto space-y-3 border-t border-slate-200 bg-white px-4 py-3">
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs text-slate-600">
                    <span>Subtotal</span>
                    <span className="font-medium tabular-nums text-slate-800">{currency(subtotal)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2 text-xs text-slate-600">
                    <span className="flex items-center gap-1.5">
                      Discount
                      <span className="inline-flex overflow-hidden rounded-md border border-slate-200 bg-white">
                        {(['peso', 'percent'] as const).map((mode) => (
                          <button key={mode} type="button" onClick={() => { setDiscountMode(mode); setDiscountInput((cur) => limitDiscountInput(cur, mode, subtotal) ?? '') }} aria-pressed={discountMode === mode}
                            className={`px-2 py-0.5 text-[11px] font-semibold transition ${discountMode === mode ? 'bg-blue-600 text-white' : 'text-slate-500 hover:bg-slate-50'}`}>
                            {mode === 'peso' ? '₱' : '%'}
                          </button>
                        ))}
                      </span>
                      {discountMode === 'percent' && discount > 0 && <span className="text-[11px] tabular-nums text-slate-500">= {currency(discount)}</span>}
                    </span>
                    <input maxLength={INPUT_LIMITS.money} type="text" inputMode="decimal" value={discountInput}
                      onChange={(e) => { const next = limitDiscountInput(e.target.value, discountMode, subtotal); if (next !== null) setDiscountInput(next) }}
                      placeholder="0" disabled={cart.length === 0 || submitting} aria-label="Discount" aria-invalid={discountTooBig}
                      className="h-8 w-24 rounded-lg border border-slate-200 bg-white px-2 text-right text-xs tabular-nums text-slate-800 focus:border-blue-500 focus:outline-none disabled:opacity-50" />
                  </div>
                  {discountTooBig && <p role="alert" className="text-right text-[11px] font-medium text-rose-600">The discount must be less than the subtotal.</p>}
                  <div className="flex items-baseline justify-between border-t border-slate-200 pt-2">
                    <span className="text-sm font-semibold text-slate-900">Total</span>
                    <span className="text-2xl font-bold tabular-nums text-slate-900">{currency(total)}</span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={checkout}
                  disabled={cart.length === 0 || submitting || discountTooBig}
                  className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-blue-600 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {submitting ? <><Loader2 aria-hidden className="h-4 w-4 animate-spin" /> Completing sale…</> : cart.length > 0 ? `Complete sale · ${currency(total)}` : 'Complete sale'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
