'use client'

// Dashboard - the landing page after login.
//
// Layout (fills one screen on desktop, per the client's wireframe):
//   top            KPI row - sales today, revenue (30 days), transactions
//                  (30 days), inventory value - one card shape for all four
//   left           Inventory Status - low stock, out of stock, reserved pieces
//                  (each opens the matching list) and the items to restock;
//                  Reservations below it - active holds, soonest to expire
//   right          Recent Activity - latest sales, reservations, stock changes;
//                  Quick actions below it - New sale, Add item, Reserve item
//
// Nothing is shown twice: low/out-of-stock counts live only in Inventory
// Status, page links live only in the sidebar, and the signed-in user only in
// the sidebar's account panel.
//
// Every figure is computed here from bounded Firestore reads (60 days of sales,
// the inventory, the latest reservations and stock logs) - nothing on this
// page is sample data. Money (revenue, inventory value, sale amounts) is shown
// only to admins and staff with View Analytics, matching the rest of the app.
//
// Quick actions:
//   New Sale     -> the sale window (components/dashboard/QuickSaleModal). A
//                   USB/Bluetooth scanner adds items inside it, and from any
//                   other page opens Sales (components/scan/GlobalScanListener).
//   Add Item     -> the Inventory page's Receive stock window: a batch of pieces,
//                   each in its own condition (components/inventory/ReceiveStockModal)
//   Reserve Item -> ReserveItemModal, submitted with the same request as the POS
//                   "Reserve Order" (lib/reservations/createReservation)

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { collection, getDocs, orderBy, query, limit, Timestamp, where } from 'firebase/firestore'
import { CalendarPlus, ChevronRight, Loader2, Package, PackagePlus, ShoppingCart, type LucideIcon } from 'lucide-react'
import { toast } from 'sonner'
import { auth, db } from '@/lib/firebase'
import { apiFetch } from '@/lib/apiFetch'
import { useConfirm } from '@/components/shared/ConfirmDialog'
import { cachedRead, loadSalesBetween } from '@/lib/client/readCache'
import ProtectedRoute from '@/components/shared/ProtectedRoute'
import { useUserRole } from '@/hooks/useUserRole'
import ReceiveStockModal from '@/components/inventory/ReceiveStockModal'
import ReserveItemModal, { type ReservableItem } from '@/components/dashboard/ReserveItemModal'
import { conditionSummary, heldLinesOf, type HeldLine } from '@/lib/reservations/heldLines'
import QuickSaleModal from '@/components/dashboard/QuickSaleModal'
import { expireReservations } from '@/lib/reservations/reservationExpiration'
import type { CategoryRef } from '@/lib/inventory/saveProduct'
import { getStockLogActionLabel, resolveStockLogAction } from '@/lib/inventory/stockLogActions'

// Loaded on demand: the camera component is only needed when someone taps Scan.

// ── Types ─────────────────────────────────────────────────────────────────────

interface LineItem { name: string; quantity: number }
interface SaleDoc {
  id: string
  items: LineItem[]
  quantity: number
  totalAmount: number
  /** Refunded since the sale (sales/refund). */
  refundedAmount: number
  createdAt: Date | null
  status: string
}
/** One per-piece item on the shelf, from /api/inventory/units/summary. */
interface ShelfEntry {
  grades: Array<{ grade: string; count: number; price: number }>
  ownPriced: Array<{ grade: string; count: number; minPrice: number; maxPrice: number }>
  reserved: number
}
interface InventoryDoc {
  id: string
  categoryId: string
  trackingMode?: 'unit' | 'quantity'
  name: string
  stock: number
  reservedStock: number
  minStock: number
  price: number
  categoryName: string
  condition: string
  conditionNotes: string
  isSingleItem: boolean
}
interface ReservationDoc { id: string; customer: string; items: LineItem[]; createdAt: Date | null }
interface ActiveReservation {
  id: string; customer: string; items: LineItem[]; expiresAt: Date | null
  /** What is held, per condition and price (lib/reservations/heldLines). */
  held: HeldLine[]
}
interface StockLogDoc {
  id: string
  actionType: string
  itemName: string
  quantityChanged: number
  createdAt: Date | null
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const toNum = (v: unknown, fb = 0): number => {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') { const p = Number(v); if (Number.isFinite(p)) return p }
  return fb
}

const toDate = (v: unknown): Date | null => {
  if (!v) return null
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v
  if (typeof v === 'object') {
    const ts = v as { toDate?: () => Date; seconds?: number; nanoseconds?: number }
    if (typeof ts.toDate === 'function') { const d = ts.toDate(); return isNaN(d.getTime()) ? null : d }
    if (typeof ts.seconds === 'number') {
      const d = new Date(ts.seconds * 1000 + Math.floor((ts.nanoseconds ?? 0) / 1e6))
      return isNaN(d.getTime()) ? null : d
    }
  }
  if (typeof v === 'string' || typeof v === 'number') { const d = new Date(v); return isNaN(d.getTime()) ? null : d }
  return null
}

const toLines = (v: unknown): LineItem[] =>
  Array.isArray(v)
    ? v.map((raw) => {
        const r = (raw ?? {}) as Record<string, unknown>
        return { name: String(r.name ?? r.itemName ?? '').trim(), quantity: Math.max(0, toNum(r.quantity)) }
      })
    : []

// Local calendar date as YYYY-MM-DD - the key used by imported sales history.
// Every day on this page is a day in the shop, in Manila time, whatever
// timezone the device is set to. Manila has no daylight saving, so a day is
// always exactly 24 hours and day arithmetic can be done in milliseconds.
const SHOP_TZ = 'Asia/Manila'
const DAY_MS = 24 * 60 * 60 * 1000
const dayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: SHOP_TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
/** YYYY-MM-DD of the shop day this moment falls in. */
const dayKeyOf = (d: Date) => dayFormatter.format(d)
/** Midnight in Manila at the start of the shop day containing d. */
const startOfDay = (d: Date) => new Date(`${dayKeyOf(d)}T00:00:00+08:00`)
const daysBefore = (d: Date, n: number) => new Date(d.getTime() - n * DAY_MS)

/** Pieces that can still be sold: stock not held for a customer. */
const freeOf = (i: { stock: number; reservedStock: number }) => i.stock - Math.min(Math.max(0, i.reservedStock), i.stock)

const peso = (n: number) =>
  `₱${n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const pcs = (n: number) => `${n.toLocaleString('en-PH')} ${n === 1 ? 'pc' : 'pcs'}`

/** "Just now", "3h ago", "2d ago", then a date. Full date and time on hover. */
const timeAgo = (d: Date, now: Date) => {
  const mins = Math.floor((now.getTime() - d.getTime()) / 60_000)
  if (mins < 1) return 'Just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

const productOf = (items: LineItem[]) => {
  const named = items.filter((i) => i.name)
  if (named.length === 0) return 'Item'
  if (named.length > 1) return `${named[0].name} +${named.length - 1} more`
  return named[0].quantity > 1 ? `${named[0].name} ×${named[0].quantity}` : named[0].name
}

/**
 * Percentage change from `prev` to `curr`.
 * 0 -> 0 is 0%; growth from zero has no percentage and returns null ("New").
 */
const pctChange = (curr: number, prev: number): number | null =>
  prev > 0 ? ((curr - prev) / prev) * 100 : curr === 0 ? 0 : null

/**
 * How soon a hold runs out: "Overdue" (past its time, not yet released by the
 * expiry sweep), "in 3h" today, "Tomorrow", then the date. Red today, amber
 * tomorrow, grey later.
 */
const expiryLabel = (expiresAt: Date | null, now: Date, today: Date): { text: string; tone: string } => {
  if (!expiresAt) return { text: 'No expiry', tone: 'bg-slate-100 text-slate-500' }
  const ms = expiresAt.getTime() - now.getTime()
  const tomorrow = daysBefore(today, -1)
  if (ms <= 0) return { text: 'Overdue', tone: 'bg-red-50 text-red-600' }
  if (expiresAt < tomorrow) {
    const text = ms < 3_600_000 ? `in ${Math.max(1, Math.round(ms / 60_000))}m` : `in ${Math.round(ms / 3_600_000)}h`
    return { text, tone: 'bg-red-50 text-red-600' }
  }
  if (expiresAt < daysBefore(today, -2)) return { text: 'Tomorrow', tone: 'bg-amber-50 text-amber-700' }
  return { text: expiresAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), tone: 'bg-slate-100 text-slate-600' }
}

// Rows per page in each dashboard list; the rest are on numbered pages.
const RESTOCK_ROWS = 5
// When Reservations is hidden, Inventory status has the whole column to itself.
const RESTOCK_ROWS_ALONE = 12
const RESERVATION_ROWS = 7
const ACTIVITY_ROWS = 12

/**
 * How many rows of a list fit its box, up to max. On the one-screen layout
 * (xl and up) panels have a fixed height, so at a larger zoom or on a short
 * screen fewer rows fit; they are measured from one row's natural height
 * (its tallest child plus padding), so rows stretched to fill the panel still
 * count right. Below xl the page scrolls and max is used.
 */
function useFitRows(max: number, ready: unknown) {
  const ref = useRef<HTMLUListElement>(null)
  const [rows, setRows] = useState(max)
  useEffect(() => {
    const el = ref.current
    if (!el) { setRows(max); return }
    const measure = () => {
      if (!window.matchMedia('(min-width: 1280px)').matches) { setRows(max); return }
      const li = el.querySelector('li')
      if (!li) return
      const cs = getComputedStyle(li)
      const content = Math.max(...Array.from(li.children).map((c) => (c as HTMLElement).offsetHeight), 0)
      const rowH = content + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderBottomWidth)
      const ecs = getComputedStyle(el)
      const room = el.clientHeight - parseFloat(ecs.paddingTop) - parseFloat(ecs.paddingBottom)
      if (rowH > 0) setRows(Math.max(1, Math.min(max, Math.floor(room / rowH))))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    window.addEventListener('resize', measure)
    return () => { ro.disconnect(); window.removeEventListener('resize', measure) }
  }, [max, ready])
  return [ref, rows] as const
}

// ── Page entry ────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  return <ProtectedRoute><DashboardContent /></ProtectedRoute>
}

function DashboardContent() {
  const { isAdmin, canViewStockLogs, can } = useUserRole()
  const canSeeMoney = isAdmin || can('canViewAnalytics')
  const canAddItem = isAdmin || can('canManageInventory')
  const canReserve = isAdmin || can('canManageReservations')
  const canOpenLogs = isAdmin || canViewStockLogs

  const [sales, setSales] = useState<SaleDoc[]>([])
  // Imported notebook totals by YYYY-MM-DD (scripts/import-sales-history.js).
  const [salesHistory, setSalesHistory] = useState<Map<string, number>>(new Map())
  const [inventory, setInventory] = useState<InventoryDoc[]>([])
  // Per-piece items on the shelf, by condition and price (/api/inventory/units/summary).
  const [shelf, setShelf] = useState<Record<string, ShelfEntry>>({})
  // Whether piece prices loaded. Without them the value fell back to "stock x
  // base price" with no warning - a different figure (on test1, ₱6,770 lower)
  // shown as if it were the real one.
  const [shelfFailed, setShelfFailed] = useState(false)
  const [reservations, setReservations] = useState<ReservationDoc[]>([])
  // Holds still in effect, for the Reservations panel. null = could not be read.
  const [activeReservations, setActiveReservations] = useState<ActiveReservation[] | null>([])
  const [stockLogs, setStockLogs] = useState<StockLogDoc[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)
  const [now, setNow] = useState(() => new Date())

  // Quick-action modals
  const [addOpen, setAddOpen] = useState(false)
  const [categories, setCategories] = useState<CategoryRef[]>([])
  const [loadingCategories, setLoadingCategories] = useState(false)
  const [reserveOpen, setReserveOpen] = useState(false)
  // New sale window. A USB scanner works inside it.
  const [saleOpen, setSaleOpen] = useState(false)

  // Reservation being completed or extended from the Reservations panel.
  // Page of the Items to restock list (RESTOCK_ROWS per page).
  const [restockPage, setRestockPage] = useState(1)
  // Inventory status: the figure that filters the list under it.
  const [statusFilter, setStatusFilter] = useState<'restock' | 'low' | 'out' | 'reserved'>('restock')
  const [reservationBusy, setReservationBusy] = useState<string | null>(null)
  // The app's own confirm window (not the browser's grey window.confirm box).
  const { confirm, confirmDialog } = useConfirm()

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), [])

  // Release overdue holds once on open, without holding up the page: when
  // the sweep released anything, reload so stock and reservations show it.
  useEffect(() => {
    expireReservations().then((released) => { if (released > 0) refresh() })
  }, [refresh])

  // `now` ticks once a minute so "today" and "3h ago" stay current.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    let cancelled = false
    async function loadData() {
      setLoadError('')
      try {
        // Every figure covers at most the last 30 days compared with the 30
        // before, so 60 days of sales is all this page can use.
        const sixtyDayCutoff = daysBefore(startOfDay(new Date()), 60)
        // What each piece sells for. If it cannot load, the value card says so
        // instead of showing a figure worked out another way.
        apiFetch('/api/inventory/units/summary')
          .then((r) => (r.ok ? r.json() : null))
          .then((s: { items?: Record<string, ShelfEntry> } | null) => {
            if (cancelled) return
            if (s?.items) { setShelf(s.items); setShelfFailed(false) } else setShelfFailed(true)
          })
          .catch(() => { if (!cancelled) setShelfFailed(true) })

        const [invSnap, saleDocs, resSnap, logsSnap, historySnap, activeResSnap] = await Promise.all([
          getDocs(collection(db, 'inventory')),
          // Days before today are remembered between visits; today's sales
          // are read fresh (lib/client/readCache).
          loadSalesBetween(sixtyDayCutoff.getTime(), daysBefore(startOfDay(new Date()), -1).getTime() - 1, 'desc'),
          // Reservations and stock logs are permission-restricted. A refused
          // read degrades to an empty list so the rest of the page still loads.
          // Only the latest few are needed for Recent Activity.
          getDocs(query(collection(db, 'reservations'), orderBy('createdAt', 'desc'), limit(10))).catch(() => null),
          getDocs(query(collection(db, 'stockLogs'), orderBy('createdAt', 'desc'), limit(40))).catch(() => null),
          // Imported notebook history up to today. Optional.
          cachedRead(`history:${dayKeyOf(sixtyDayCutoff)}:${dayKeyOf(new Date())}`, 30 * 60_000, () => getDocs(query(
            collection(db, 'salesHistory'),
            where('dateKey', '>=', dayKeyOf(sixtyDayCutoff)),
            where('dateKey', '<=', dayKeyOf(new Date()))
          ))).catch(() => null),
          // Every active hold, for the Reservations panel (sorted by expiry below).
          getDocs(query(collection(db, 'reservations'), where('status', '==', 'Active'))).catch(() => null),
        ])
        if (cancelled) return

        setInventory(invSnap.docs.flatMap((d) => {
          const data = d.data() as Record<string, unknown>
          // Trash and written-off items are not active product lines.
          if (data.isDeleted === true || data.isVoided === true) return []
          return [{
            id: d.id,
            name: String(data.name ?? '').trim() || d.id,
            stock: Math.max(0, toNum(data.stock ?? data.quantity)),
            reservedStock: Math.max(0, toNum(data.reservedStock)),
            minStock: Math.max(0, toNum(data.minStock)),
            price: Math.max(0, toNum(data.price)),
            categoryId: typeof data.categoryId === 'string' ? data.categoryId : '',
            trackingMode: data.trackingMode === 'unit' ? 'unit' as const : data.trackingMode === 'quantity' ? 'quantity' as const : undefined,
            categoryName: String(data.categoryName ?? data.category ?? '').trim() || 'Uncategorized',
            condition: data.condition === 'Refurbished' ? 'Refurbished' : 'New',
            conditionNotes: typeof data.conditionNotes === 'string' ? data.conditionNotes.trim() : '',
            isSingleItem: data.isSingleItem === true,
          }]
        }))
        setSales(saleDocs.map((d) => {
          const data = d.data() as Record<string, unknown>
          const items = toLines(data.items)
          return {
            id: d.id,
            items,
            quantity: toNum(data.quantity, items.reduce((s, i) => s + i.quantity, 0)),
            totalAmount: toNum(data.totalAmount),
            refundedAmount: toNum(data.refundedAmount),
            status: String(data.status ?? 'completed'),
            createdAt: toDate(data.createdAt),
          }
        }))
        const history = new Map<string, number>()
        ;(historySnap?.docs ?? []).forEach((d) => {
          const data = d.data() as Record<string, unknown>
          const total = toNum(data.total)
          if (typeof data.dateKey === 'string' && total > 0) history.set(data.dateKey, total)
        })
        setSalesHistory(history)
        setReservations((resSnap?.docs ?? []).map((d) => {
          const data = d.data() as Record<string, unknown>
          return {
            id: d.id,
            customer:
              (typeof data.customer === 'string' && data.customer.trim()) ||
              (typeof data.customerName === 'string' && data.customerName.trim()) || '',
            items: toLines(data.items),
            createdAt: toDate(data.createdAt),
          }
        }))
        setActiveReservations(activeResSnap ? activeResSnap.docs
          .map((d) => {
            const data = d.data() as Record<string, unknown>
            return {
              id: d.id,
              customer:
                (typeof data.customer === 'string' && data.customer.trim()) ||
                (typeof data.customerName === 'string' && data.customerName.trim()) ||
                'Walk-in Customer',
              items: toLines(data.items).filter((i) => i.quantity > 0),
              held: heldLinesOf(data.items),
              expiresAt: toDate(data.expiresAt),
            }
          })
          // Soonest to expire first; holds with no expiry go last.
          .sort((a, b) => (a.expiresAt?.getTime() ?? Infinity) - (b.expiresAt?.getTime() ?? Infinity))
          : null)
        setStockLogs((logsSnap?.docs ?? []).map((d) => {
          const data = d.data() as Record<string, unknown>
          return {
            id: d.id,
            actionType: String(data.actionType ?? ''),
            itemName: String(data.itemName ?? '').trim(),
            quantityChanged: toNum(data.quantityChanged),
            createdAt: toDate(data.createdAt),
          }
        }))
      } catch (e) {
        console.error('Dashboard load failed:', e)
        if (!cancelled) setLoadError('Some dashboard figures could not be loaded. Check your connection and try again.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    loadData()
    return () => { cancelled = true }
  }, [refreshKey])

  // ── KPIs ──────────────────────────────────────────────────────────────────

  const today = useMemo(() => startOfDay(now), [now])
  const thirtyDaysAgo = useMemo(() => daysBefore(today, 29), [today])  // 30 calendar days including today
  const sixtyDaysAgo = useMemo(() => daysBefore(today, 59), [today])

  // Voided sales never count. Refunded sales stay in the history they belong to.
  const completedSales = useMemo(() => sales.filter((s) => s.status !== 'voided'), [sales])

  // Revenue per calendar day. On a day with an imported notebook total, that
  // total replaces what was recorded (never added to it). Transaction counts
  // stay recorded-only: the notebook does not say how many sales made up a day.
  const dailyRevenue = useMemo(() => {
    const map = new Map<string, number>()
    for (const s of completedSales) {
      if (!s.createdAt) continue
      const key = dayKeyOf(s.createdAt)
      // What was kept: refunds come off the day the sale was made.
      map.set(key, (map.get(key) ?? 0) + Math.max(0, s.totalAmount - s.refundedAmount))
    }
    salesHistory.forEach((total, key) => map.set(key, total))
    return map
  }, [completedSales, salesHistory])

  const dailyCount = useMemo(() => {
    const map = new Map<string, number>()
    for (const s of completedSales) {
      if (!s.createdAt) continue
      // A fully refunded sale kept nothing, so it is not counted - as on
      // Analytics. Counting it made the two pages disagree for the same days
      // (161 here against 154 there on test1). Part refunds still count.
      if (s.status === 'refunded') continue
      const key = dayKeyOf(s.createdAt)
      map.set(key, (map.get(key) ?? 0) + 1)
    }
    return map
  }, [completedSales])

  const sumOver = (map: Map<string, number>, from: Date, n: number) =>
    Array.from({ length: n }, (_, i) => new Date(from.getTime() + i * DAY_MS))
      .reduce((s, d) => s + (map.get(dayKeyOf(d)) ?? 0), 0)

  const revenue30 = useMemo(() => sumOver(dailyRevenue, thirtyDaysAgo, 30), [dailyRevenue, thirtyDaysAgo]) // eslint-disable-line react-hooks/exhaustive-deps
  const revenuePrev30 = useMemo(() => sumOver(dailyRevenue, sixtyDaysAgo, 30), [dailyRevenue, sixtyDaysAgo]) // eslint-disable-line react-hooks/exhaustive-deps
  const sales30 = useMemo(() => sumOver(dailyCount, thirtyDaysAgo, 30), [dailyCount, thirtyDaysAgo]) // eslint-disable-line react-hooks/exhaustive-deps
  const salesPrev30 = useMemo(() => sumOver(dailyCount, sixtyDaysAgo, 30), [dailyCount, sixtyDaysAgo]) // eslint-disable-line react-hooks/exhaustive-deps
  const salesToday = dailyCount.get(dayKeyOf(today)) ?? 0
  const salesYesterday = dailyCount.get(dayKeyOf(daysBefore(today, 1))) ?? 0
  // Peso total of today's completed sales (refunds and voids excluded by completedSales).
  const revenueToday = dailyRevenue.get(dayKeyOf(today)) ?? 0
  const revenueYesterday = dailyRevenue.get(dayKeyOf(daysBefore(today, 1))) ?? 0

  // ── Inventory ─────────────────────────────────────────────────────────────

  // Worth of an item's stock: per-piece items at each piece's price (own price,
  // or its condition's); held pieces at the item's cheapest condition on the
  // shelf. Counted items at their price.
  const valueOf = useCallback((i: InventoryDoc) => {
    const s = shelf[i.id]
    if (!s) return i.stock * i.price
    const priced = s.grades.reduce((n, g) => n + g.count * g.price, 0)
      + s.ownPriced.reduce((n, g) => n + g.count * (g.minPrice + g.maxPrice) / 2, 0)
    const heldAt = s.grades.length ? Math.min(...s.grades.map((g) => g.price)) : i.price
    return priced + s.reserved * heldAt
  }, [shelf])

  const stock = useMemo(() => {
    let low = 0, out = 0, pieces = 0, reserved = 0, value = 0
    for (const i of inventory) {
      const free = i.stock - Math.min(i.reservedStock, i.stock)
      if (free <= 0) out++
      else if (free <= i.minStock) low++
      pieces += i.stock
      reserved += Math.min(i.reservedStock, i.stock)
      value += valueOf(i)
    }
    return { lines: inventory.length, low, out, pieces, reserved, value }
  }, [inventory, valueOf])

  // Items to restock: out of stock first, then lowest stock relative to minimum.
  const attentionItems = useMemo(() =>
    inventory
      .filter((i) => freeOf(i) <= i.minStock)
      .sort((a, b) =>
        (freeOf(a) <= 0 ? 0 : 1) - (freeOf(b) <= 0 ? 0 : 1) ||
        freeOf(a) / Math.max(1, a.minStock) - freeOf(b) / Math.max(1, b.minStock) ||
        a.name.localeCompare(b.name)),
    [inventory])

  const reservedItems = useMemo(() =>
    inventory
      .filter((i) => i.reservedStock > 0)
      .map((i) => ({
        id: i.id,
        name: i.name,
        categoryName: i.categoryName,
        reserved: Math.min(i.reservedStock, i.stock),
        stock: i.stock,
        holders: (activeReservations ?? []).flatMap((r) => {
          const lines = r.held.filter((l) => l.id === i.id)
          const qty = lines.reduce((n, l) => n + l.quantity, 0)
          return qty > 0 ? [{ id: r.id, customer: r.customer, qty, conditions: conditionSummary(lines), expiresAt: r.expiresAt }] : []
        }),
      }))
      .sort((a, b) => b.reserved - a.reserved || a.name.localeCompare(b.name)),
    [inventory, activeReservations])

  // Rows for the Inventory status list, by the figure that is selected.
  type StatusRow = { id: string; name: string; sub: string; figure: string; tag: string; tagTone: string }
  const statusRows = useMemo<StatusRow[]>(() => {
    if (statusFilter === 'reserved') {
      return reservedItems.map((i) => ({
        id: i.id,
        name: i.name,
        sub: i.holders.length > 0 ? i.holders.map((h) => `${h.customer} (${h.conditions || h.qty})`).join(', ') : i.categoryName,
        figure: `${pcs(i.stock - i.reserved)} free`,
        tag: `${pcs(i.reserved)} held`,
        tagTone: 'bg-blue-50 text-blue-600',
      }))
    }
    return attentionItems
      .filter((i) => statusFilter === 'restock' || (statusFilter === 'out' ? freeOf(i) <= 0 : freeOf(i) > 0))
      .map((i) => ({
        id: i.id,
        name: i.name,
        sub: `${i.categoryName || 'Uncategorized'} · min ${i.minStock}`,
        figure: i.reservedStock > 0 ? `${pcs(freeOf(i))} free of ${i.stock}` : `${pcs(i.stock)} left`,
        tag: freeOf(i) <= 0 ? 'Out of stock' : 'Low stock',
        tagTone: freeOf(i) <= 0 ? 'bg-red-50 text-red-600' : 'bg-amber-50 text-amber-700',
      }))
  }, [statusFilter, attentionItems, reservedItems])
  const STATUS_TITLE = { restock: 'Items to restock', low: 'Low stock', out: 'Out of stock', reserved: 'Reserved pieces' } as const
  const STATUS_EMPTY = { restock: 'Every product is above its minimum stock.', low: 'Nothing is running low.', out: 'Nothing is out of stock.', reserved: 'Nothing is on hold right now.' } as const
  const pickStatus = (next: 'low' | 'out' | 'reserved') => { setStatusFilter((cur) => (cur === next ? 'restock' : next)); setRestockPage(1) }
  const [restockRef, restockRows] = useFitRows(canReserve ? RESTOCK_ROWS : RESTOCK_ROWS_ALONE, `${loading}-${statusRows.length}-${statusFilter}`)
  const restockPages = Math.max(1, Math.ceil(statusRows.length / restockRows))
  const restockPageSafe = Math.min(restockPage, restockPages)

  const reservable = useMemo<ReservableItem[]>(() =>
    inventory.map((i) => ({
      id: i.id,
      name: i.name,
      categoryName: i.categoryName,
      price: i.price,
      condition: i.condition,
      availableStock: Math.max(0, i.stock - i.reservedStock),
      // Condition prices are read by the New sale and Reserve windows themselves.
      trackingMode: i.trackingMode,
      isSingleItem: i.isSingleItem,
      conditionNotes: i.conditionNotes,
    })),
    [inventory])

  // ── Recent activity ───────────────────────────────────────────────────────

  const activity = useMemo(() => {
    type Row = {
      key: string; kind: 'sale' | 'reservation' | 'stock'
      title: string; detail: string; figure: string; figureTone: string; date: Date
    }
    const rows: Row[] = []
    for (const s of completedSales.slice(0, 15)) {
      if (!s.createdAt) continue
      const refunded = s.status === 'refunded' ? 'Sale refunded' : s.status === 'partially_refunded' ? 'Sale partly refunded' : 'Sale completed'
      rows.push({
        key: `s-${s.id}`, kind: 'sale', title: refunded, detail: productOf(s.items),
        figure: canSeeMoney ? `+${peso(s.totalAmount)}` : pcs(s.quantity),
        figureTone: s.status.toLowerCase().includes('refund') ? 'text-red-600' : 'text-blue-600',
        date: s.createdAt,
      })
    }
    for (const r of reservations) {
      if (!r.createdAt) continue
      const qty = r.items.reduce((n, i) => n + i.quantity, 0)
      rows.push({
        key: `r-${r.id}`, kind: 'reservation', title: 'Reservation made',
        detail: r.customer ? `${r.customer}, ${productOf(r.items)}` : productOf(r.items),
        figure: pcs(qty), figureTone: 'text-slate-500', date: r.createdAt,
      })
    }
    for (const l of stockLogs) {
      if (!l.createdAt || !l.itemName) continue
      const action = resolveStockLogAction({ actionType: l.actionType, quantityChanged: l.quantityChanged })
      // Sales and reservations already appear above from their own records.
      if (action === 'sale_deduction' || action === 'reservation_deduction') continue
      const q = l.quantityChanged
      const added = q > 0 && (action === 'item_added' || action === 'stock_increased' || action === 'stock_adjust')
      rows.push({
        key: `l-${l.id}`, kind: 'stock',
        title: added ? 'Stock updated' : getStockLogActionLabel(action),
        detail: l.itemName,
        figure: q === 0 ? '' : `${q > 0 ? '+' : '−'}${pcs(Math.abs(q))}`,
        figureTone: q > 0 ? 'text-blue-600' : 'text-slate-500',
        date: l.createdAt,
      })
    }
    return rows.sort((a, b) => b.date.getTime() - a.date.getTime()).slice(0, ACTIVITY_ROWS)
  }, [completedSales, reservations, stockLogs, canSeeMoney])

  // ── Reservation actions ───────────────────────────────────────────────────
  //
  // The same PATCH /api/reservations/[id] requests, confirmations and messages
  // as the Reservations page. Cancelling needs a reason, so it stays there.

  const reservationAction = async (r: ActiveReservation, action: 'complete' | 'extend') => {
    if (reservationBusy) return
    if (!(await confirm({
      title: action === 'complete' ? 'Claim this reservation?' : 'Extend the hold?',
      message: action === 'complete'
        ? <>Customer paid and is taking the items now?<br /><span className="font-medium text-slate-800">{r.customer}</span></>
        : <>Give <span className="font-medium text-slate-800">{r.customer}</span> more time to collect.</>,
      confirmLabel: action === 'complete' ? 'Claim' : 'Extend',
      tone: action === 'complete' ? 'success' : 'primary',
    }))) return
    setReservationBusy(r.id)
    try {
      const res = await apiFetch('/api/reservations/' + r.id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          ...(action === 'complete' ? { collected: true } : {}),
          processedBy: {
            uid: auth.currentUser?.uid ?? '',
            email: auth.currentUser?.email ?? '',
            name: auth.currentUser?.displayName ?? auth.currentUser?.email ?? '',
          },
        }),
      })
      const payload = (await res.json()) as { error?: string }
      const failed = action === 'complete' ? 'Failed to complete reservation.' : 'Failed to extend the hold.'
      if (!res.ok) throw new Error(payload.error || failed)
      toast.success(action === 'complete' ? 'Reservation completed successfully.' : 'Hold extended.')
      refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Reservation update failed.')
    } finally {
      setReservationBusy(null)
    }
  }

  // ── Quick-action handlers ─────────────────────────────────────────────────

  const openAddItem = async () => {
    if (loadingCategories) return
    // Open only once categories are in: the window starts on the first one, and
    // it resets when the category list changes, which would wipe what was typed.
    if (categories.length > 0) { setAddOpen(true); return }
    setLoadingCategories(true)
    try {
      const snap = await getDocs(collection(db, 'categories'))
      const list = snap.docs
        .map((d) => ({ id: d.id, name: String((d.data() as Record<string, unknown>).name ?? '').trim() }))
        .filter((c) => c.name)
        .sort((a, b) => a.name.localeCompare(b.name))
      setCategories(list)
      if (list.length === 0) {
        toast.error('Create a category on the Inventory page before adding items.')
        return
      }
      setAddOpen(true)
    } catch (e) {
      console.error('Loading categories failed:', e)
      toast.error('Could not load categories. Please try again.')
    } finally {
      setLoadingCategories(false)
    }
  }


  // ── Render ────────────────────────────────────────────────────────────────
  //
  // On desktop (xl) the page is exactly one screen tall, laid out as the
  // client's wireframe: KPI row across the top; Inventory status over
  // Reservations on the left; Recent activity over the quick actions on the
  // right. Lists longer than their panel scroll inside it. Below xl the page
  // flows and scrolls normally.

  const [reservationRef, reservationRows] = useFitRows(RESERVATION_ROWS, `${loading}-${activeReservations?.length ?? 0}`)
  const [activityRef, activityRows] = useFitRows(ACTIVITY_ROWS, `${loading}-${activity.length}`)

  const salesTodayChange = canSeeMoney ? pctChange(revenueToday, revenueYesterday) : pctChange(salesToday, salesYesterday)

  // Only the actions this account may take; New sale is always there.
  const quickActions = [
    <QuickAction key="sale" onClick={() => setSaleOpen(true)} icon={ShoppingCart} title="New sale" desc="Ring up a sale" hint="or scan any item" tone="primary" />,
    ...(canAddItem ? [<QuickAction key="add" onClick={openAddItem} busy={loadingCategories} icon={PackagePlus} title="Add stock" desc="Put new pieces on the shelf" />] : []),
    ...(canReserve ? [<QuickAction key="reserve" onClick={() => setReserveOpen(true)} icon={CalendarPlus} title="Reserve item" desc="Hold stock for a customer" />] : []),
  ]

  return (
    <div className="flex min-h-full flex-col bg-[#F1F5FC] xl:h-screen xl:overflow-hidden">
      <div className="flex flex-col gap-2 p-3 xl:min-h-0 xl:flex-1">
        {/* Same page title as every other page. */}
        <div className="shrink-0">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Dashboard</h1>
          <p className="text-xs text-slate-500">Today at a glance: sales, stock and reservations.</p>
        </div>
        {confirmDialog}

        {loadError && (
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm text-rose-700">
            <span>{loadError}</span>
            <button type="button" onClick={refresh} className="font-medium underline underline-offset-2">Retry</button>
          </div>
        )}

        {/* KPI row - every card has the same three lines: label, figure, comparison.
            Without money access there is only one figure, so the quick actions
            move up beside it and the row stays full instead of half empty. */}
        <div className={`grid shrink-0 grid-cols-1 gap-2 sm:grid-cols-2 ${canSeeMoney ? 'xl:grid-cols-4' : TOP_ROW_COLS[quickActions.length + 1]}`}>
          {/* Pesos for whoever may see money; otherwise the number of sales. */}
          <KpiCard title="Sales today" value={canSeeMoney ? peso(revenueToday) : String(salesToday)} loading={loading}
            caption={<><ChangeBadge v={salesTodayChange} /><span>
              {canSeeMoney
                ? `${salesToday} sale${salesToday === 1 ? '' : 's'} · yesterday ${peso(revenueYesterday)}`
                : `vs yesterday (${salesYesterday})`}
            </span></>} />
          {canSeeMoney && (
            <KpiCard title="Revenue, 30 days" value={peso(revenue30)} loading={loading}
              caption={<><ChangeBadge v={pctChange(revenue30, revenuePrev30)} /><span>vs previous 30 days</span></>} />
          )}
          {canSeeMoney && (
            <KpiCard title="Transactions, 30 days" value={sales30.toLocaleString('en-PH')} loading={loading}
              caption={<><ChangeBadge v={pctChange(sales30, salesPrev30)} /><span>vs previous 30 days</span></>} />
          )}
          {canSeeMoney && (
            <KpiCard title="Inventory value" value={shelfFailed ? '—' : peso(stock.value)} loading={loading}
              caption={shelfFailed
                ? <span>Piece prices did not load · {pcs(stock.pieces)}</span>
                : <span>{pcs(stock.pieces)} across {stock.lines} product lines</span>} />
          )}
          {!canSeeMoney && quickActions}
        </div>

        <div className="grid grid-cols-1 gap-2 xl:min-h-0 xl:flex-1 xl:grid-cols-12">
          {/* Inventory Status - the only place low/out-of-stock counts appear. */}
          {/* Left column: stock on top, reservations below. */}
          <div className="flex flex-col gap-2 xl:col-span-5 xl:min-h-0">
          <Panel className="xl:flex-1" title="Inventory status" href="/inventory" linkLabel="Open inventory">
            {loading ? <div className="m-5 h-48 animate-pulse rounded-lg bg-slate-50" /> : (
              <div className="flex h-full min-h-0 flex-col">
                <div className="mx-4 grid shrink-0 grid-cols-3 divide-x divide-slate-200/80 overflow-hidden rounded-xl border border-slate-200/80">
                  <StatusTile onClick={() => pickStatus('low')} active={statusFilter === 'low'} label="Low stock" count={stock.low}
                    labelTone="text-slate-500" tone="text-slate-900" hint="at or below min" />
                  <StatusTile onClick={() => pickStatus('out')} active={statusFilter === 'out'} label="Out of stock" count={stock.out}
                    labelTone="text-slate-500" tone={stock.out > 0 ? 'text-red-600' : 'text-slate-900'} hint="needs restocking" />
                  <StatusTile onClick={() => pickStatus('reserved')} active={statusFilter === 'reserved'} label="Reserved" count={stock.reserved} unit={stock.reserved === 1 ? 'pc' : 'pcs'}
                    labelTone="text-slate-500" tone="text-blue-600" hint="on hold" />
                </div>

                <div className="mt-3 flex shrink-0 items-center justify-between border-t border-slate-100 px-4 pb-1 pt-2.5">
                  <h3 className="text-xs font-semibold text-slate-800">
                    {STATUS_TITLE[statusFilter]}
                    {statusFilter !== 'restock' && (
                      <button type="button" onClick={() => { setStatusFilter('restock'); setRestockPage(1) }}
                        className={`ml-2 rounded text-xs font-medium text-blue-600 hover:text-blue-700 ${FOCUS}`}>Show all</button>
                    )}
                  </h3>
                  <span className="text-xs tabular-nums text-slate-500">{statusRows.length} item{statusRows.length === 1 ? '' : 's'}</span>
                </div>
                {statusRows.length === 0 ? (
                  <p className="px-4 py-5 text-center text-[13px] text-slate-500">{STATUS_EMPTY[statusFilter]}</p>
                ) : (
                  <ul ref={restockRef} className="min-h-0 flex-1 overflow-hidden px-4">
                    {statusRows.slice((restockPageSafe - 1) * restockRows, restockPageSafe * restockRows).map((r) => (
                      <li key={r.id} className="flex items-center gap-3 border-b border-slate-100 py-1.5 last:border-0">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs font-semibold text-slate-800" title={r.name}>{r.name}</p>
                          <p className="truncate text-xs text-slate-500" title={r.sub}>{r.sub}</p>
                        </div>
                        <span className="shrink-0 text-xs tabular-nums text-slate-600">{r.figure}</span>
                        <span className={`w-[86px] shrink-0 rounded-md py-0.5 text-center text-xs font-medium ${r.tagTone}`}>{r.tag}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {restockPages > 1 && (
                  <Pager page={restockPageSafe} pages={restockPages} onPage={setRestockPage} />
                )}
              </div>
            )}
          </Panel>

          {/* Reservations - active holds, soonest to expire first. */}
          {canReserve && (
            <Panel className="xl:flex-1" title="Reservations" href="/reservations" linkLabel="Open reservations">
              {loading ? <div className="m-5 h-48 animate-pulse rounded-lg bg-slate-50" /> : !activeReservations ? (
                <p className="px-4 py-8 text-center text-[13px] text-slate-500">Reservations could not be loaded.</p>
              ) : activeReservations.length === 0 ? (
                <p className="px-4 py-8 text-center text-[13px] text-slate-500">
                  No active reservations. Use Reserve item below to hold stock for a customer.
                </p>
              ) : (
                <div className="flex h-full min-h-0 flex-col">
                  <div className="flex shrink-0 items-baseline justify-between px-4 pb-1">
                    <span className="text-xs text-slate-500">
                      <span className="text-xl font-bold tabular-nums text-slate-900">{activeReservations.length}</span> active
                    </span>
                    {(() => {
                      const dueToday = activeReservations.filter((r) => r.expiresAt && r.expiresAt < daysBefore(today, -1)).length
                      return dueToday > 0
                        ? <span className="text-xs font-medium text-red-600">{dueToday} expire today</span>
                        : <span className="text-xs text-slate-500">None expire today</span>
                    })()}
                  </div>
                  <ul ref={reservationRef} className="flex min-h-0 flex-1 flex-col overflow-hidden px-4 pb-1">
                    {activeReservations.slice(0, reservationRows).map((r) => {
                      const qty = r.items.reduce((n, i) => n + i.quantity, 0)
                      const exp = expiryLabel(r.expiresAt, now, today)
                      return (
                        <li key={r.id} className="flex items-center gap-3 border-b border-slate-100 py-1.5 last:border-0 xl:max-h-[60px] xl:min-h-0 xl:flex-1">
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-xs font-semibold text-slate-800" title={r.customer}>{r.customer}</p>
                            <p className="truncate text-xs text-slate-500" title={conditionSummary(r.held)}>
                              {productOf(r.items)}, {pcs(qty)}
                              {r.held.length > 0 && <span className="text-slate-500"> · {conditionSummary(r.held)}</span>}
                            </p>
                          </div>
                          <span
                            title={r.expiresAt ? `Expires ${r.expiresAt.toLocaleString('en-US')}` : 'No expiry set'}
                            className={`shrink-0 rounded-md px-1.5 py-0.5 text-xs font-medium tabular-nums ${exp.tone}`}
                          >
                            {exp.text}
                          </span>
                          <div className="flex shrink-0 gap-1">
                            <button
                              type="button"
                              onClick={() => reservationAction(r, 'extend')}
                              disabled={!!reservationBusy}
                              className={`h-7 rounded-md border border-slate-200 bg-white px-2 text-xs font-semibold text-slate-700 transition-colors hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60 ${FOCUS}`}
                            >
                              Extend
                            </button>
                            <button
                              type="button"
                              onClick={() => reservationAction(r, 'complete')}
                              disabled={!!reservationBusy}
                              className={`inline-flex h-7 items-center gap-1 rounded-md bg-blue-600 px-2 text-xs font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60 ${FOCUS}`}
                            >
                              {reservationBusy === r.id && <Loader2 aria-hidden className="h-3 w-3 animate-spin" />}
                              Complete
                            </button>
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )}
            </Panel>
          )}
          </div>

          {/* Right column: recent activity, quick actions beneath it. */}
          <div className="flex flex-col gap-2 xl:col-span-7 xl:min-h-0">
          {/* Recent Activity */}
          <Panel
            className="xl:flex-1"
            title="Recent activity"
            href={canOpenLogs ? '/inventory/logs' : '/sales'}
            linkLabel={canOpenLogs ? 'View stock logs' : 'View sales'}
          >
            {loading ? <div className="m-5 h-48 animate-pulse rounded-lg bg-slate-50" /> : activity.length === 0 ? (
              <p className="px-4 py-8 text-center text-[13px] text-slate-500">
                No activity yet. Sales, reservations and stock changes will show up here.
              </p>
            ) : (
              // Rows share the panel's height but stop at a set maximum (here
              // and in Reservations), so two or three entries sit at the top
              // instead of being spread over the whole panel.
              <ul ref={activityRef} className="flex h-full flex-col overflow-hidden px-4 pb-1">
                {activity.slice(0, activityRows).map((row) => (
                  <li key={row.key} className="flex items-center gap-3 border-b border-slate-100 py-2 last:border-0 xl:max-h-[68px] xl:min-h-0 xl:flex-1">
                    <KindIcon kind={row.kind} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-slate-800">{row.title}</p>
                      <p className="truncate text-[13px] text-slate-500" title={row.detail}>{row.detail}</p>
                    </div>
                    {row.figure && <span className={`shrink-0 text-sm font-medium tabular-nums ${row.figureTone}`}>{row.figure}</span>}
                    <time
                      dateTime={row.date.toISOString()}
                      title={row.date.toLocaleString('en-US')}
                      className="w-20 shrink-0 whitespace-nowrap text-right text-[13px] tabular-nums text-slate-500"
                    >
                      {timeAgo(row.date, now)}
                    </time>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          {/* Quick actions - the things done from here on the spot. Page links
              live in the sidebar, not here. Without money access they sit in
              the top row instead (see above). */}
          {canSeeMoney && (
            <section aria-label="Quick actions" className={`shrink-0 p-2.5 ${CARD}`}>
              <div className={`grid grid-cols-1 gap-2.5 ${QUICK_COLS[quickActions.length]}`}>
                {quickActions}
              </div>
            </section>
          )}
          </div>
        </div>
      </div>

      {canAddItem && (
        <ReceiveStockModal
          isOpen={addOpen}
          onClose={() => setAddOpen(false)}
          categories={categories}
          items={inventory.filter((i) => !i.isSingleItem && i.categoryId).map((i) => ({
            id: i.id, name: i.name, categoryId: i.categoryId, category: i.categoryName, price: i.price, trackingMode: i.trackingMode,
          }))}
          onReceived={refresh}
        />
      )}
      <QuickSaleModal
        isOpen={saleOpen}
        onClose={() => setSaleOpen(false)}
        items={reservable}
        loading={loading}
        onSold={refresh}
      />
      {canReserve && (
        <ReserveItemModal
          isOpen={reserveOpen}
          onClose={() => setReserveOpen(false)}
          items={reservable}
          loading={loading}
          onReserved={refresh}
        />
      )}
    </div>
  )
}

// ── Design tokens ─────────────────────────────────────────────────────────────

// Static class names (Tailwind only ships classes it can see in the source).
// Top row without money access: Sales today plus one tile per quick action.
const TOP_ROW_COLS: Record<number, string> = { 2: 'xl:grid-cols-2', 3: 'xl:grid-cols-3', 4: 'xl:grid-cols-4' }
const QUICK_COLS: Record<number, string> = { 1: '', 2: 'sm:grid-cols-2', 3: 'sm:grid-cols-3' }

const FOCUS = 'outline-none focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-2'
const CARD = 'rounded-xl border border-slate-200/70 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_24px_-12px_rgba(15,23,42,0.10)]'

// Activity type: one small icon tile per row, coloured by kind.
const KIND_META = {
  sale:        { icon: ShoppingCart, label: 'Sale',        tile: 'bg-blue-50 text-blue-600' },
  reservation: { icon: CalendarPlus, label: 'Reservation', tile: 'bg-blue-50 text-blue-600' },
  stock:       { icon: Package,      label: 'Stock',       tile: 'bg-slate-100 text-slate-600' },
} as const

function KindIcon({ kind }: { kind: keyof typeof KIND_META }) {
  const { icon: Icon, label, tile } = KIND_META[kind]
  return (
    <span title={label} className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${tile}`}>
      <Icon aria-hidden className="h-4 w-4" />
      <span className="sr-only">{label}</span>
    </span>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function KpiCard({ title, value, caption, loading }: { title: string; value: string; caption: React.ReactNode; loading: boolean }) {
  return (
    <div className={`relative overflow-hidden px-4 py-3 ${CARD}`}>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">{title}</p>
      {loading ? (
        <div className="mt-2 space-y-2">
          <div className="h-7 w-32 animate-pulse rounded bg-slate-100" />
          <div className="h-4 w-40 animate-pulse rounded bg-slate-100" />
        </div>
      ) : (
        <>
          <p className="mt-0.5 truncate text-2xl font-bold leading-tight tracking-tight tabular-nums text-slate-900">{value}</p>
          <div className="mt-1 flex min-h-[22px] flex-wrap items-center gap-1.5 text-xs text-slate-500">{caption}</div>
        </>
      )}
    </div>
  )
}

function ChangeBadge({ v }: { v: number | null }) {
  if (v === null) {
    return <span className="rounded-md bg-blue-50 px-1.5 py-0.5 font-medium text-blue-600">New</span>
  }
  const rounded = Math.round(v * 10) / 10
  const tone = rounded > 0 ? 'bg-emerald-50 text-emerald-700' : rounded < 0 ? 'bg-rose-50 text-rose-600' : 'bg-slate-100 text-slate-600'
  const arrow = rounded > 0 ? '↑ ' : rounded < 0 ? '↓ ' : ''
  return <span className={`rounded-md px-1.5 py-0.5 font-medium tabular-nums ${tone}`}>{arrow}{Math.abs(rounded).toFixed(rounded === 0 ? 0 : 1)}%</span>
}

/** The one card shape for every section: title and link on top, content below. */
function Panel({ title, href, linkLabel, className = '', children }: {
  title: string; href: string; linkLabel: string; className?: string; children: React.ReactNode
}) {
  return (
    <section className={`flex flex-col overflow-hidden ${CARD} xl:min-h-0 ${className}`}>
      <div className="flex shrink-0 items-center justify-between gap-3 px-4 pb-2 pt-3">
        <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
        <Link href={href} className={`inline-flex items-center gap-0.5 rounded text-xs font-medium text-blue-600 hover:text-blue-700 ${FOCUS}`}>
          {linkLabel}<ChevronRight aria-hidden className="h-3.5 w-3.5" />
        </Link>
      </div>
      <div className="xl:min-h-0 xl:flex-1">{children}</div>
    </section>
  )
}

/** 1 2 3 4 5 page buttons; long runs collapse to first, last and neighbours. */
function Pager({ page, pages, onPage, label = 'Restock list pages' }: { page: number; pages: number; onPage: (p: number) => void; label?: string }) {
  const nums = Array.from({ length: pages }, (_, i) => i + 1)
    .filter((p) => pages <= 7 || p === 1 || p === pages || Math.abs(p - page) <= 1)
  const btn = `h-7 min-w-7 rounded-md px-1.5 text-xs tabular-nums transition-colors disabled:opacity-40 ${FOCUS}`
  return (
    <nav aria-label={label} className="mt-auto flex shrink-0 items-center justify-end gap-1 border-t border-slate-100 px-4 py-2">
      <button type="button" onClick={() => onPage(page - 1)} disabled={page === 1} aria-label="Previous page"
        className={`${btn} border border-slate-200 text-slate-600 hover:bg-slate-50`}>‹</button>
      {nums.map((p, i) => (
        <span key={p} className="flex items-center gap-1">
          {i > 0 && p - nums[i - 1] > 1 && <span className="w-4 text-center text-xs text-slate-500">…</span>}
          <button type="button" onClick={() => onPage(p)} aria-current={p === page ? 'page' : undefined}
            className={`${btn} ${p === page ? 'bg-blue-600 font-semibold text-white' : 'border border-slate-200 text-slate-600 hover:bg-slate-50'}`}>
            {p}
          </button>
        </span>
      ))}
      <button type="button" onClick={() => onPage(page + 1)} disabled={page === pages} aria-label="Next page"
        className={`${btn} border border-slate-200 text-slate-600 hover:bg-slate-50`}>›</button>
    </nav>
  )
}

function StatusTile({ href, onClick, active, label, count, unit, tone, labelTone, hint }: {
  href?: string; onClick?: () => void; active?: boolean; label: string; count: number; unit?: string; tone: string; labelTone: string; hint?: string
}) {
  const cls = `relative block w-full px-3 py-2.5 text-left transition-colors ${active ? 'bg-blue-50' : 'hover:bg-slate-50'} ${FOCUS}`
  const body = (
    <>
      <span className={`block text-[10px] font-semibold uppercase tracking-wide ${active ? 'text-blue-600' : labelTone}`}>{label}</span>
      <span className={`mt-0.5 block text-2xl font-bold leading-tight tabular-nums ${tone}`}>
        {count.toLocaleString('en-PH')}
        {unit && <span className="ml-1 text-xs font-medium text-slate-500">{unit}</span>}
      </span>
      {hint && <span className="block truncate text-[11px] text-slate-500">{hint}</span>}
      {active && <span aria-hidden className="absolute inset-x-0 bottom-0 h-[3px] bg-blue-600" />}
    </>
  )
  return href ? <Link href={href} className={cls}>{body}</Link> : <button type="button" onClick={onClick} aria-pressed={active} className={cls}>{body}</button>
}

// The two actions done most at the counter get a solid fill; the third a
// white tile. All share one shape: icon tile, title over a
// short line, and an arrow that moves on hover.
const QUICK_TONE = {
  primary: {
    tile: 'bg-blue-600 text-white shadow-[0_8px_18px_-10px_rgba(37,99,235,0.7)] hover:bg-blue-700',
    icon: 'bg-white/15 text-white ring-1 ring-inset ring-white/25',
    desc: 'text-blue-100/90',
    arrow: 'text-white/70',
  },
  success: {
    tile: 'bg-emerald-600 text-white shadow-[0_8px_18px_-10px_rgba(5,150,105,0.7)] hover:bg-emerald-700',
    icon: 'bg-white/15 text-white ring-1 ring-inset ring-white/25',
    desc: 'text-emerald-50/90',
    arrow: 'text-white/70',
  },
  default: {
    tile: 'border border-slate-200 bg-white text-slate-900 shadow-[0_1px_2px_rgba(15,23,42,0.05),0_10px_22px_-14px_rgba(15,23,42,0.25)] hover:border-slate-300 hover:bg-slate-50',
    icon: 'bg-blue-50 text-blue-600 ring-1 ring-inset ring-blue-100',
    desc: 'text-slate-500',
    arrow: 'text-slate-500',
  },
} as const

function QuickAction({ title, desc, hint, icon: Icon, href, onClick, busy, tone = 'default' }: {
  title: string; desc: string; hint?: string; icon: LucideIcon; href?: string; onClick?: () => void; busy?: boolean; tone?: keyof typeof QUICK_TONE
}) {
  const t = QUICK_TONE[tone]
  const cls = `group flex h-full min-h-[68px] w-full items-center gap-3 rounded-xl px-3.5 text-left transition-all duration-150 hover:-translate-y-px active:translate-y-0 disabled:cursor-wait disabled:opacity-70 ${FOCUS} ${t.tile}`
  const body = (
    <>
      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${t.icon}`}>
        {busy
          ? <Loader2 aria-hidden className="h-5 w-5 animate-spin" />
          : <Icon aria-hidden className="h-5 w-5" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-semibold leading-tight">{title}</span>
        <span className={`mt-0.5 block truncate text-xs ${t.desc}`}>{desc}{hint ? ` ${hint}` : ''}</span>
      </span>
      <ChevronRight aria-hidden className={`h-4 w-4 shrink-0 transition-transform duration-150 group-hover:translate-x-0.5 ${t.arrow}`} />
    </>
  )
  return href
    ? <Link href={href} className={cls}>{body}</Link>
    : <button type="button" onClick={onClick} disabled={busy} className={cls}>{body}</button>
}
