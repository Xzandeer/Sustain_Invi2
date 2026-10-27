'use client'

// Dashboard - the landing page after login.
//
// Layout (one screen on desktop, no page scroll):
//   header        title, today's date, quick actions
//   KPI row       revenue (30 days), transactions (30 days), active products,
//                 open reservations
//   left          Today at a glance - today's figures against a usual day of
//                 the same weekday and sales by hour - with today's
//                 transactions in their own card below
//   right         Reservations to act on (expiring today / tomorrow) and the
//                 items that need restocking
//
// Every figure is computed here from bounded Firestore reads (60 days of sales,
// the inventory, the active reservations) - nothing on this page is sample data.
//
// "Usual <weekday>" is the average of the same weekday over the previous four
// weeks (7, 14, 21 and 28 days ago), all inside the 60 days already loaded.
//
// Money (revenue, amounts, average sale) is shown only to admins and staff with
// View Analytics, matching the rest of the app. Without it, sales by hour counts
// transactions instead of pesos.
//
// Quick actions:
//   New Sale     -> /sales (the POS)
//   Add Item     -> the Inventory page's own ProductModal, saved with the same
//                   request (lib/inventory/saveProduct)
//   Reserve Item -> ReserveItemModal, submitted with the same request as the POS
//                   "Reserve Order" (lib/reservations/createReservation)
//   Stock Logs   -> /inventory/logs
//   Complete (on a reservation) -> the same PATCH /api/reservations/[id]
//                   'complete' request as the Reservations page

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { collection, getDocs, orderBy, query, Timestamp, where } from 'firebase/firestore'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Tooltip,
  type ChartOptions,
} from 'chart.js'
import { Bar } from 'react-chartjs-2'
import { ChevronRight, Loader2, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { auth, db } from '@/lib/firebase'
import { apiFetch } from '@/lib/apiFetch'
import ProtectedRoute from '@/components/shared/ProtectedRoute'
import { useUserRole } from '@/hooks/useUserRole'
import ProductModal, { type ProductFormValues } from '@/components/inventory/ProductModal'
import ReserveItemModal, { type ReservableItem } from '@/components/dashboard/ReserveItemModal'
import { saveProduct, type CategoryRef } from '@/lib/inventory/saveProduct'

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip)

// ── Types ─────────────────────────────────────────────────────────────────────

interface LineItem { name: string; quantity: number }
interface SaleDoc {
  id: string
  items: LineItem[]
  quantity: number
  totalAmount: number
  refundedAmount: number
  createdAt: Date | null
  status: string
}
interface InventoryDoc {
  id: string
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
interface ReservationDoc {
  id: string
  customer: string
  items: LineItem[]
  expiresAt: Date | null
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
const dayKeyOf = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const startOfDay = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x }
const daysBefore = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() - n); return x }

const peso = (n: number) =>
  `₱${n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** Whole pesos - for the compact figures on the Today panel. */
const pesoWhole = (n: number) => `₱${Math.round(n).toLocaleString('en-PH')}`

const pesoAxis = (n: number) => (n >= 1000 ? `₱${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k` : `₱${Math.round(n)}`)

const time = (d: Date) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })

const hourLabel = (h: number) => `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'a' : 'p'}`

const productOf = (items: LineItem[]) => {
  const named = items.filter((i) => i.name)
  if (named.length === 0) return 'Item'
  return named.length === 1 ? named[0].name : `${named[0].name} +${named.length - 1} more`
}

/**
 * Percentage change from `prev` to `curr`.
 * 0 -> 0 is 0%; growth from zero has no percentage and returns null ("New").
 */
const pctChange = (curr: number, prev: number): number | null =>
  prev > 0 ? ((curr - prev) / prev) * 100 : curr === 0 ? 0 : null

// Opening hours drawn on the hourly chart. Sales outside them widen the axis.
const OPEN_HOUR = 9
const CLOSE_HOUR = 18

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
  // null = could not be read (no permission or offline), [] = none active.
  const [reservations, setReservations] = useState<ReservationDoc[] | null>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)
  const [now, setNow] = useState(() => new Date())
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)

  // Quick-action modals
  const [addOpen, setAddOpen] = useState(false)
  const [categories, setCategories] = useState<CategoryRef[]>([])
  const [loadingCategories, setLoadingCategories] = useState(false)
  const [savingItem, setSavingItem] = useState(false)
  const [reserveOpen, setReserveOpen] = useState(false)
  const [completingId, setCompletingId] = useState<string | null>(null)

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), [])

  // `now` ticks once a minute so "today" and the expiry countdowns stay current.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    let cancelled = false
    async function loadData() {
      setLoadError('')
      try {
        // The 30-day KPIs compare with the 30 days before, and the usual-day
        // comparison reaches back 28 days, so 60 days of sales covers both.
        const sixtyDayCutoff = daysBefore(startOfDay(new Date()), 60)

        const [invSnap, salesSnap, resSnap, historySnap] = await Promise.all([
          getDocs(collection(db, 'inventory')),
          getDocs(query(
            collection(db, 'sales'),
            where('createdAt', '>=', Timestamp.fromDate(sixtyDayCutoff)),
            orderBy('createdAt', 'desc')
          )),
          // Permission-restricted. A refused read leaves the reservation
          // figures blank instead of failing the whole page.
          getDocs(query(collection(db, 'reservations'), where('status', '==', 'Active'))).catch(() => null),
          // Imported notebook history up to today. Optional.
          getDocs(query(
            collection(db, 'salesHistory'),
            where('dateKey', '>=', dayKeyOf(sixtyDayCutoff)),
            where('dateKey', '<=', dayKeyOf(new Date()))
          )).catch(() => null),
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
            categoryName: String(data.categoryName ?? data.category ?? '').trim() || 'Uncategorized',
            condition: data.condition === 'Refurbished' ? 'Refurbished' : 'New',
            conditionNotes: typeof data.conditionNotes === 'string' ? data.conditionNotes.trim() : '',
            isSingleItem: data.isSingleItem === true,
          }]
        }))
        setSales(salesSnap.docs.map((d) => {
          const data = d.data() as Record<string, unknown>
          const items = toLines(data.items)
          return {
            id: d.id,
            items,
            quantity: toNum(data.quantity, items.reduce((s, i) => s + i.quantity, 0)),
            totalAmount: toNum(data.totalAmount),
            refundedAmount: Math.max(0, toNum(data.refundedAmount)),
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
        setReservations(resSnap ? resSnap.docs.map((d) => {
          const data = d.data() as Record<string, unknown>
          return {
            id: d.id,
            customer:
              (typeof data.customer === 'string' && data.customer.trim()) ||
              (typeof data.customerName === 'string' && data.customerName.trim()) ||
              'Walk-in Customer',
            items: toLines(data.items).filter((i) => i.quantity > 0),
            expiresAt: toDate(data.expiresAt),
          }
        }) : null)
        setUpdatedAt(new Date())
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

  // ── Period KPIs ───────────────────────────────────────────────────────────

  const today = useMemo(() => startOfDay(now), [now])
  const thirtyDaysAgo = useMemo(() => daysBefore(today, 29), [today])  // 30 calendar days including today
  const sixtyDaysAgo = useMemo(() => daysBefore(today, 59), [today])

  // Voided sales never count. Refunded sales stay in the history they belong to.
  const completedSales = useMemo(() => sales.filter((s) => s.status !== 'voided'), [sales])

  // Revenue per calendar day. On a day with an imported notebook total, that
  // total replaces what was recorded (never added to it). Transaction counts
  // stay recorded-only: the notebook does not say how many sales made up a day.
  const recordedRevenue = useMemo(() => {
    const map = new Map<string, number>()
    for (const s of completedSales) {
      if (!s.createdAt) continue
      const key = dayKeyOf(s.createdAt)
      map.set(key, (map.get(key) ?? 0) + s.totalAmount)
    }
    return map
  }, [completedSales])

  const dailyRevenue = useMemo(() => {
    const map = new Map(recordedRevenue)
    salesHistory.forEach((total, key) => map.set(key, total))
    return map
  }, [recordedRevenue, salesHistory])

  const dailyCount = useMemo(() => {
    const map = new Map<string, number>()
    for (const s of completedSales) {
      if (!s.createdAt) continue
      const key = dayKeyOf(s.createdAt)
      map.set(key, (map.get(key) ?? 0) + 1)
    }
    return map
  }, [completedSales])

  const sumOver = (map: Map<string, number>, from: Date, n: number) =>
    Array.from({ length: n }, (_, i) => { const d = new Date(from); d.setDate(d.getDate() + i); return d })
      .reduce((s, d) => s + (map.get(dayKeyOf(d)) ?? 0), 0)

  const revenue30 = useMemo(() => sumOver(dailyRevenue, thirtyDaysAgo, 30), [dailyRevenue, thirtyDaysAgo]) // eslint-disable-line react-hooks/exhaustive-deps
  const revenuePrev30 = useMemo(() => sumOver(dailyRevenue, sixtyDaysAgo, 30), [dailyRevenue, sixtyDaysAgo]) // eslint-disable-line react-hooks/exhaustive-deps
  const sales30 = useMemo(() => sumOver(dailyCount, thirtyDaysAgo, 30), [dailyCount, thirtyDaysAgo]) // eslint-disable-line react-hooks/exhaustive-deps
  const salesPrev30 = useMemo(() => sumOver(dailyCount, sixtyDaysAgo, 30), [dailyCount, sixtyDaysAgo]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Inventory ─────────────────────────────────────────────────────────────

  const stockBreakdown = useMemo(() => {
    let inStock = 0, low = 0, out = 0
    for (const i of inventory) {
      if (i.stock <= 0) out++
      else if (i.stock <= i.minStock) low++
      else inStock++
    }
    return { inStock, low, out, total: inventory.length }
  }, [inventory])

  // Items to restock: out of stock first, then lowest stock relative to minimum.
  const attentionItems = useMemo(() =>
    inventory
      .filter((i) => i.stock <= 0 || i.stock <= i.minStock)
      .sort((a, b) =>
        (a.stock <= 0 ? 0 : 1) - (b.stock <= 0 ? 0 : 1) ||
        a.stock / Math.max(1, a.minStock) - b.stock / Math.max(1, b.minStock) ||
        a.name.localeCompare(b.name)),
    [inventory])

  const reservable = useMemo<ReservableItem[]>(() =>
    inventory.map((i) => ({
      id: i.id,
      name: i.name,
      categoryName: i.categoryName,
      price: i.price,
      condition: i.condition,
      availableStock: Math.max(0, i.stock - i.reservedStock),
      isSingleItem: i.isSingleItem,
      conditionNotes: i.conditionNotes,
    })),
    [inventory])

  // ── Today at a glance ─────────────────────────────────────────────────────

  const weekdayName = now.toLocaleDateString('en-US', { weekday: 'long' })
  // The same weekday over the previous four weeks.
  const usualDays = useMemo(() => [7, 14, 21, 28].map((n) => daysBefore(today, n)), [today])

  const todaySales = useMemo(
    () => completedSales.filter((s) => s.createdAt && s.createdAt >= today).sort((a, b) => b.createdAt!.getTime() - a.createdAt!.getTime()),
    [completedSales, today])

  const todayStats = useMemo(() => {
    const key = dayKeyOf(today)
    const revenue = dailyRevenue.get(key) ?? 0
    const recorded = recordedRevenue.get(key) ?? 0
    const count = todaySales.length
    const refunded = todaySales.filter((s) => s.refundedAmount > 0)

    const avg = (map: Map<string, number>) => usualDays.reduce((s, d) => s + (map.get(dayKeyOf(d)) ?? 0), 0) / usualDays.length
    const usualCount = avg(dailyCount)
    const usualRecorded = avg(recordedRevenue)

    return {
      revenue,
      usualRevenue: avg(dailyRevenue),
      count,
      usualCount,
      items: todaySales.reduce((s, x) => s + x.quantity, 0),
      refunds: refunded.length,
      refundTotal: refunded.reduce((s, x) => s + x.refundedAmount, 0),
      // Average sale uses recorded sales only: imported notebook days have a
      // total but no transaction count.
      avgSale: count > 0 ? recorded / count : 0,
      usualAvgSale: usualCount > 0 ? usualRecorded / usualCount : 0,
    }
  }, [today, todaySales, dailyRevenue, recordedRevenue, dailyCount, usualDays])

  const hourly = useMemo(() => {
    const hourOf = (d: Date) => d.getHours()
    const usualDayKeys = new Set(usualDays.map(dayKeyOf))
    const usualSales = completedSales.filter((s) => s.createdAt && usualDayKeys.has(dayKeyOf(s.createdAt)))

    const hoursSeen = [...todaySales, ...usualSales].map((s) => hourOf(s.createdAt!))
    const first = Math.min(OPEN_HOUR, ...hoursSeen)
    const last = Math.max(CLOSE_HOUR, ...hoursSeen)
    const hours = Array.from({ length: last - first + 1 }, (_, i) => first + i)

    const metric = (s: SaleDoc) => (canSeeMoney ? s.totalAmount : 1)
    const todayByHour = new Map<number, number>()
    todaySales.forEach((s) => todayByHour.set(hourOf(s.createdAt!), (todayByHour.get(hourOf(s.createdAt!)) ?? 0) + metric(s)))
    const usualByHour = new Map<number, number>()
    usualSales.forEach((s) => usualByHour.set(hourOf(s.createdAt!), (usualByHour.get(hourOf(s.createdAt!)) ?? 0) + metric(s) / usualDays.length))

    const currentHour = now.getHours()
    return {
      hours,
      today: hours.map((h) => (h > currentHour ? null : todayByHour.get(h) ?? 0)),
      usual: hours.map((h) => usualByHour.get(h) ?? 0),
    }
  }, [completedSales, todaySales, usualDays, now, canSeeMoney])

  // ── Reservations to act on ────────────────────────────────────────────────

  const reservationGroups = useMemo(() => {
    if (!reservations) return null
    const tomorrow = daysBefore(today, -1)
    const dayAfter = daysBefore(today, -2)
    const dated = reservations.filter((r) => r.expiresAt).sort((a, b) => a.expiresAt!.getTime() - b.expiresAt!.getTime())
    return {
      // Includes holds already past their time that the expiry sweep has not
      // released yet - those are the most urgent of all.
      today: dated.filter((r) => r.expiresAt! < tomorrow),
      tomorrow: dated.filter((r) => r.expiresAt! >= tomorrow && r.expiresAt! < dayAfter),
      later: reservations.length - dated.filter((r) => r.expiresAt! < dayAfter).length,
      total: reservations.length,
    }
  }, [reservations, today])

  const completeReservation = async (r: ReservationDoc) => {
    if (completingId) return
    if (!window.confirm('Customer paid and is taking the items now?\n\n' + r.customer)) return
    setCompletingId(r.id)
    try {
      const res = await apiFetch('/api/reservations/' + r.id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'complete',
          collected: true,
          processedBy: {
            uid: auth.currentUser?.uid ?? '',
            email: auth.currentUser?.email ?? '',
            name: auth.currentUser?.displayName ?? auth.currentUser?.email ?? '',
          },
        }),
      })
      const payload = (await res.json()) as { error?: string }
      if (!res.ok) throw new Error(payload.error || 'Failed to complete reservation.')
      toast.success('Reservation completed successfully.')
      refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to complete reservation.')
    } finally {
      setCompletingId(null)
    }
  }

  // ── Quick-action handlers ─────────────────────────────────────────────────

  const openAddItem = async () => {
    if (loadingCategories) return
    // Open only once categories are in: ProductModal resets its form when its
    // default category changes, so opening early would wipe what was typed.
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

  const handleSaveItem = async (values: ProductFormValues) => {
    if (savingItem) return
    setSavingItem(true)
    try {
      await saveProduct(values, categories)
      setAddOpen(false)
      toast.success('Inventory item added successfully.')
      refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save item.')
    } finally {
      setSavingItem(false)
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const todayLabel = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  const kpiCount = 1 + (canSeeMoney ? 2 : 0) + (canReserve ? 1 : 0)
  const KPI_COLS: Record<number, string> = { 1: 'xl:grid-cols-1', 2: 'xl:grid-cols-2', 3: 'xl:grid-cols-3', 4: 'xl:grid-cols-4' }

  return (
    <div className="flex min-h-full flex-col bg-[#f5f6fa] xl:h-screen xl:overflow-hidden">
      {/* Header: title, today's date, and the quick actions (same permission
          rules as the sidebar and the APIs behind them). */}
      <header className="shrink-0 border-b border-slate-200/70 bg-white px-4 py-2.5 sm:px-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-baseline gap-3">
            <h1 className="text-lg font-bold tracking-tight text-slate-900">Dashboard</h1>
            <p className="hidden text-xs text-slate-500 sm:block">{todayLabel}</p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {canOpenLogs && <ActionButton href="/inventory/logs" label="Stock Logs" />}
            {canReserve && <ActionButton onClick={() => setReserveOpen(true)} label="Reserve Item" />}
            {canAddItem && <ActionButton onClick={openAddItem} busy={loadingCategories} label="Add Item" />}
            <ActionButton href="/sales" label="New Sale" primary />
          </div>
        </div>
      </header>

      <div className="flex flex-col gap-3 p-3 sm:px-4 xl:min-h-0 xl:flex-1">
        {loadError && (
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">
            <span>{loadError}</span>
            <button type="button" onClick={refresh} className="font-semibold underline underline-offset-2">Retry</button>
          </div>
        )}

        {/* KPI row */}
        <div className={`grid shrink-0 grid-cols-1 gap-3 sm:grid-cols-2 ${KPI_COLS[kpiCount]}`}>
          {canSeeMoney && (
            <KpiCard title="Revenue, 30 days" value={peso(revenue30)} loading={loading}
              footer={<><ChangeBadge v={pctChange(revenue30, revenuePrev30)} /><span className="text-slate-500">vs prev. 30 days</span></>} />
          )}
          {canSeeMoney && (
            <KpiCard title="Transactions, 30 days" value={String(sales30)} loading={loading}
              footer={<><ChangeBadge v={pctChange(sales30, salesPrev30)} /><span className="text-slate-500">vs prev. 30 days</span></>} />
          )}
          <KpiCard title="Active products" value={String(stockBreakdown.total)} loading={loading}
            footer={
              <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-slate-600">
                <Dot color="bg-green-500" label={`${stockBreakdown.inStock} in stock`} />
                <Dot color="bg-amber-500" label={`${stockBreakdown.low} low`} />
                <Dot color="bg-red-500" label={`${stockBreakdown.out} out`} />
              </span>
            } />
          {canReserve && (
            <KpiCard title="Open reservations" value={reservationGroups ? String(reservationGroups.total) : '—'} loading={loading}
              footer={!reservationGroups ? <span className="text-slate-400">Could not load reservations</span>
                : reservationGroups.today.length > 0
                  ? <span className="font-medium text-red-600">{reservationGroups.today.length} expire today</span>
                  : <span className="text-slate-500">None expire today</span>} />
          )}
        </div>

        <div className="grid grid-cols-1 gap-3 xl:min-h-0 xl:flex-1 xl:grid-cols-12">
          {/* ── Left column: Today at a glance, then today's transactions ─── */}
          <div className="flex flex-col gap-3 xl:col-span-8 xl:min-h-0">
          <section className={`flex flex-col ${CARD} xl:min-h-0 xl:flex-[1.15]`}>
            <div className="flex shrink-0 items-start justify-between gap-3 px-4 pt-3">
              <div>
                <h2 className="text-[15px] font-semibold text-slate-900">Today at a glance</h2>
                <p className="text-xs text-slate-500">Compared with a usual {weekdayName} (average of the last 4)</p>
              </div>
              {updatedAt && (
                <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />Updated {time(updatedAt)}
                </span>
              )}
            </div>

            <div className={`mx-4 mt-3 grid shrink-0 grid-cols-2 gap-2 ${canSeeMoney ? 'lg:grid-cols-4' : ''}`}>
              {canSeeMoney && (
                <TodayTile label="Revenue" value={pesoWhole(todayStats.revenue)} loading={loading}
                  note={<Delta curr={todayStats.revenue} prev={todayStats.usualRevenue} pct suffix={`vs ${pesoWhole(todayStats.usualRevenue)}`} />} />
              )}
              <TodayTile label="Transactions" value={String(todayStats.count)} loading={loading}
                note={<Delta curr={todayStats.count} prev={todayStats.usualCount} suffix={`vs ${round1(todayStats.usualCount)} usual`} />} />
              <TodayTile label="Items sold" value={`${todayStats.items} ${todayStats.items === 1 ? 'pc' : 'pcs'}`} loading={loading}
                note={<span className="text-slate-500">
                  {todayStats.refunds === 0 ? 'No refunds'
                    : `${todayStats.refunds} refund${todayStats.refunds === 1 ? '' : 's'}${canSeeMoney ? `, ${pesoWhole(todayStats.refundTotal)}` : ''}`}
                </span>} />
              {canSeeMoney && (
                <TodayTile label="Average sale" value={pesoWhole(todayStats.avgSale)} loading={loading}
                  note={todayStats.count === 0 ? <span className="text-slate-500">No sales yet today</span>
                    : <Delta curr={todayStats.avgSale} prev={todayStats.usualAvgSale} money suffix="vs usual" />} />
              )}
            </div>

            <div className="flex flex-col px-4 pb-3 pt-3 xl:min-h-0 xl:flex-1">
              {/* Sales by hour */}
              <div className="flex shrink-0 flex-wrap items-center gap-x-6 gap-y-1">
                <h3 className="text-sm font-semibold text-slate-900">Sales by hour</h3>
                <span className="flex items-center gap-4 text-[11px] text-slate-500">
                  <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-blue-600" />Today</span>
                  <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-blue-300" />Usual {weekdayName}</span>
                </span>
              </div>
              <div className="relative mt-1 h-44 shrink-0 xl:h-auto xl:min-h-[110px] xl:flex-1">
                <div className="absolute inset-0">
                  {loading ? <div className="h-full animate-pulse rounded-lg bg-slate-50" />
                    : <HourlyChart labels={hourly.hours.map(hourLabel)} today={hourly.today} usual={hourly.usual} money={canSeeMoney} weekday={weekdayName} />}
                </div>
              </div>
            </div>
          </section>

          {/* Today's transactions */}
          <section className={`flex flex-col ${CARD} xl:min-h-0 xl:flex-1`}>
            <CardHeader title="Today's transactions" href="/sales" linkLabel="View all" />
            <div className="max-h-72 overflow-y-auto px-4 pb-3 [scrollbar-width:thin] xl:max-h-none xl:min-h-0 xl:flex-1">
                {loading ? <div className="h-24 animate-pulse rounded-lg bg-slate-50" />
                  : todaySales.length === 0 ? (
                    <p className="py-6 text-center text-xs text-slate-400">No sales yet today. They&apos;ll appear here as they&apos;re rung up.</p>
                  ) : (
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-slate-50 text-[11px] text-slate-500">
                        <tr>
                          <th className="px-3 py-1.5 text-left font-medium">Time</th>
                          <th className="px-3 py-1.5 text-left font-medium">Product</th>
                          <th className="px-3 py-1.5 text-left font-medium">Qty</th>
                          {canSeeMoney && <th className="px-3 py-1.5 text-left font-medium">Amount</th>}
                          <th className="px-3 py-1.5 text-left font-medium">Type</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {todaySales.map((s) => {
                          const type = s.status === 'refunded' ? 'Refunded' : s.status === 'partially_refunded' ? 'Part refunded' : 'Sale'
                          return (
                            <tr key={s.id}>
                              <td className="whitespace-nowrap px-3 py-1.5 tabular-nums text-slate-500">{time(s.createdAt!)}</td>
                              <td className="max-w-[260px] truncate px-3 py-1.5 font-medium text-slate-800" title={productOf(s.items)}>{productOf(s.items)}</td>
                              <td className="px-3 py-1.5 tabular-nums text-slate-600">{s.quantity}</td>
                              {canSeeMoney && <td className="whitespace-nowrap px-3 py-1.5 tabular-nums text-slate-800">{peso(s.totalAmount)}</td>}
                              <td className="px-3 py-1.5">
                                <span className={`whitespace-nowrap rounded-md px-2 py-0.5 text-[11px] font-medium ${
                                  type === 'Sale' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'
                                }`}>{type}</span>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  )}
            </div>
          </section>
          </div>

          {/* ── Right column ──────────────────────────────────────────────── */}
          <div className={`grid grid-cols-1 gap-3 xl:col-span-4 xl:min-h-0 ${canReserve ? 'xl:grid-rows-[minmax(0,1fr)_minmax(0,1fr)]' : ''}`}>
            {canReserve && (
              <section className={`flex min-h-0 flex-col ${CARD}`}>
                <CardHeader title="Reservations to act on" href="/reservations" linkLabel="View all" />
                <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-2 [scrollbar-width:thin]">
                  {loading ? <div className="h-32 animate-pulse rounded-lg bg-slate-50" />
                    : !reservationGroups ? (
                      <p className="py-6 text-center text-xs text-slate-400">Reservations could not be loaded.</p>
                    ) : reservationGroups.today.length + reservationGroups.tomorrow.length === 0 ? (
                      <p className="py-6 text-center text-xs text-slate-400">
                        Nothing expires today or tomorrow.{reservationGroups.total > 0 ? ` ${reservationGroups.total} open reservation${reservationGroups.total === 1 ? '' : 's'} due later.` : ''}
                      </p>
                    ) : (
                      <>
                        {reservationGroups.today.length > 0 && (
                          <ReservationGroup title={`Expires today (${reservationGroups.today.length})`} tone="text-red-600">
                            {reservationGroups.today.map((r) => (
                              <ReservationRow key={r.id} r={r} now={now} urgent busy={completingId === r.id} disabled={!!completingId} onComplete={() => completeReservation(r)} />
                            ))}
                          </ReservationGroup>
                        )}
                        {reservationGroups.tomorrow.length > 0 && (
                          <ReservationGroup title={`Expires tomorrow (${reservationGroups.tomorrow.length})`} tone="text-amber-600">
                            {reservationGroups.tomorrow.map((r) => (
                              <ReservationRow key={r.id} r={r} now={now} busy={completingId === r.id} disabled={!!completingId} onComplete={() => completeReservation(r)} />
                            ))}
                          </ReservationGroup>
                        )}
                      </>
                    )}
                </div>
                {reservationGroups && reservationGroups.later > 0 && (
                  <Link href="/reservations" className={`mx-4 flex shrink-0 items-center justify-between border-t border-slate-100 py-2 text-xs text-slate-500 hover:text-slate-800 ${FOCUS}`}>
                    {reservationGroups.later} more due later
                    <ChevronRight className="h-4 w-4" />
                  </Link>
                )}
              </section>
            )}

            <section className={`flex min-h-0 flex-col ${CARD}`}>
              <CardHeader title="Needs restocking" href="/inventory?status=Low+Stock" linkLabel="View inventory" />
              <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3 [scrollbar-width:thin]">
                {loading ? <div className="h-32 animate-pulse rounded-lg bg-slate-50" />
                  : attentionItems.length === 0 ? (
                    <p className="py-6 text-center text-xs text-slate-400">Every product is above its minimum stock.</p>
                  ) : (
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-slate-50 text-[11px] text-slate-500">
                        <tr>
                          <th className="px-2 py-1.5 text-left font-medium">Product</th>
                          <th className="px-2 py-1.5 text-center font-medium">Stock / Min</th>
                          <th className="px-2 py-1.5 text-left font-medium">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {attentionItems.map((i) => {
                          const out = i.stock <= 0
                          return (
                            <tr key={i.id}>
                              <td className="max-w-[170px] truncate px-2 py-1.5 font-medium text-slate-800" title={i.name}>{i.name}</td>
                              <td className={`px-2 py-1.5 text-center tabular-nums ${out ? 'font-semibold text-red-600' : 'text-slate-600'}`}>{i.stock} / {i.minStock}</td>
                              <td className="px-2 py-1.5">
                                <span className={`whitespace-nowrap rounded-md px-2 py-0.5 text-[11px] font-medium ${out ? 'bg-red-50 text-red-600' : 'bg-amber-50 text-amber-700'}`}>
                                  {out ? 'Out of Stock' : 'Low Stock'}
                                </span>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  )}
              </div>
            </section>
          </div>
        </div>
      </div>

      {canAddItem && (
        <ProductModal
          isOpen={addOpen}
          onClose={() => { if (!savingItem) setAddOpen(false) }}
          onSubmit={handleSaveItem}
          categories={categories}
          submitting={savingItem}
        />
      )}
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

const FOCUS = 'outline-none focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-2'
const CARD = 'rounded-xl border border-slate-200/80 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]'

const round1 = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1))

// ── Sub-components ────────────────────────────────────────────────────────────

function KpiCard({ title, value, footer, loading }: { title: string; value: string; footer: React.ReactNode; loading: boolean }) {
  return (
    <div className={`px-4 py-3 ${CARD}`}>
      <p className="text-xs font-medium text-slate-500">{title}</p>
      {loading ? (
        <div className="mt-1.5 space-y-2">
          <div className="h-6 w-28 animate-pulse rounded bg-slate-100" />
          <div className="h-3.5 w-36 animate-pulse rounded bg-slate-100" />
        </div>
      ) : (
        <>
          <p className="mt-0.5 truncate text-[22px] font-bold leading-tight tracking-tight tabular-nums text-slate-900">{value}</p>
          <div className="mt-1 flex min-h-[20px] flex-wrap items-center gap-2 text-xs">{footer}</div>
        </>
      )}
    </div>
  )
}

function ChangeBadge({ v }: { v: number | null }) {
  if (v === null) {
    return <span className="rounded-md bg-blue-50 px-1.5 py-0.5 font-semibold text-blue-600">New</span>
  }
  const rounded = Math.round(v * 10) / 10
  const tone = rounded > 0 ? 'bg-emerald-50 text-emerald-700' : rounded < 0 ? 'bg-rose-50 text-rose-600' : 'bg-slate-100 text-slate-600'
  const arrow = rounded > 0 ? '↑ ' : rounded < 0 ? '↓ ' : ''
  return <span className={`rounded-md px-1.5 py-0.5 font-semibold tabular-nums ${tone}`}>{arrow}{Math.abs(rounded).toFixed(rounded === 0 ? 0 : 1)}%</span>
}

function Dot({ color, label }: { color: string; label: string }) {
  return <span className="flex items-center gap-1.5 tabular-nums"><span className={`h-2 w-2 rounded-full ${color}`} />{label}</span>
}

function TodayTile({ label, value, note, loading }: { label: string; value: string; note: React.ReactNode; loading: boolean }) {
  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2">
      <p className="text-[11px] text-slate-500">{label}</p>
      {loading ? (
        <div className="mt-1 space-y-1.5">
          <div className="h-5 w-16 animate-pulse rounded bg-slate-200/70" />
          <div className="h-3 w-20 animate-pulse rounded bg-slate-200/70" />
        </div>
      ) : (
        <>
          <p className="truncate text-lg font-bold leading-tight tabular-nums text-slate-900">{value}</p>
          <p className="mt-0.5 truncate text-[11px] tabular-nums">{note}</p>
        </>
      )}
    </div>
  )
}

/** Change against the usual day: a percentage, a peso amount, or a plain count. */
function Delta({ curr, prev, pct, money, suffix }: { curr: number; prev: number; pct?: boolean; money?: boolean; suffix: string }) {
  const diff = curr - prev
  let text: string
  if (pct) {
    const p = pctChange(curr, prev)
    text = p === null ? 'New' : `${Math.abs(Math.round(p))}%`
  } else if (money) {
    text = pesoWhole(Math.abs(diff))
  } else {
    text = round1(Math.abs(Math.round(diff * 10) / 10))
  }
  const up = diff > 0.05, down = diff < -0.05
  return (
    <>
      <span className={`font-semibold ${up ? 'text-emerald-600' : down ? 'text-rose-600' : 'text-slate-500'}`}>
        {up ? '↑ ' : down ? '↓ ' : ''}{text}
      </span>{' '}
      <span className="text-slate-500">{suffix}</span>
    </>
  )
}

function HourlyChart({ labels, today, usual, money, weekday }: {
  labels: string[]; today: Array<number | null>; usual: number[]; money: boolean; weekday: string
}) {
  const fmt = (v: number) => (money ? peso(v) : `${round1(Math.round(v * 10) / 10)} sale${v === 1 ? '' : 's'}`)
  const options: ChartOptions<'bar'> = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: 'rgba(15,23,42,0.9)',
        padding: 10,
        cornerRadius: 8,
        callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${fmt(Number(ctx.parsed.y ?? 0))}` },
      },
    },
    scales: {
      x: { grid: { display: false }, border: { display: false }, ticks: { color: '#94a3b8', font: { size: 11 } } },
      y: {
        beginAtZero: true,
        grid: { color: '#f1f5f9' },
        border: { display: false },
        ticks: { color: '#94a3b8', font: { size: 11 }, maxTicksLimit: 4, precision: 0, callback: (v) => (money ? pesoAxis(Number(v)) : String(v)) },
      },
    },
  }
  return (
    <Bar
      options={options}
      data={{
        labels,
        datasets: [
          { label: 'Today', data: today, backgroundColor: '#2563eb', borderRadius: 3, maxBarThickness: 16, categoryPercentage: 0.6, barPercentage: 0.9 },
          { label: `Usual ${weekday}`, data: usual, backgroundColor: '#93c5fd', borderRadius: 3, maxBarThickness: 16, categoryPercentage: 0.6, barPercentage: 0.9 },
        ],
      }}
    />
  )
}

function CardHeader({ title, href, linkLabel }: { title: string; href: string; linkLabel: string }) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-3 px-4 pb-2 pt-3">
      <h2 className="text-[15px] font-semibold text-slate-900">{title}</h2>
      <Link href={href} className={`rounded text-xs font-semibold text-blue-600 hover:text-blue-700 ${FOCUS}`}>{linkLabel}</Link>
    </div>
  )
}

function ReservationGroup({ title, tone, children }: { title: string; tone: string; children: React.ReactNode }) {
  return (
    <div className="mb-2">
      <p className={`text-xs font-medium ${tone}`}>{title}</p>
      <ul className="divide-y divide-slate-100">{children}</ul>
    </div>
  )
}

function ReservationRow({ r, now, urgent, busy, disabled, onComplete }: {
  r: ReservationDoc; now: Date; urgent?: boolean; busy: boolean; disabled: boolean; onComplete: () => void
}) {
  const ms = (r.expiresAt?.getTime() ?? 0) - now.getTime()
  const left = !urgent
    ? r.expiresAt!.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : ms <= 0 ? 'Overdue'
      : ms < 3_600_000 ? `in ${Math.max(1, Math.round(ms / 60_000))}m`
        : `in ${Math.round(ms / 3_600_000)}h`
  const qty = r.items.reduce((s, i) => s + i.quantity, 0)
  return (
    <li className="flex items-center gap-2 py-2">
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium text-slate-800" title={r.customer}>{r.customer}</p>
        <p className="truncate text-[11px] text-slate-500">{productOf(r.items)}, {qty} {qty === 1 ? 'pc' : 'pcs'}</p>
      </div>
      <span
        title={r.expiresAt?.toLocaleString('en-US')}
        className={`shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium tabular-nums ${urgent ? 'bg-red-50 text-red-600' : 'bg-amber-50 text-amber-700'}`}
      >
        {left}
      </span>
      <button
        type="button"
        onClick={onComplete}
        disabled={disabled}
        className={`inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2.5 text-[11px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${FOCUS} ${
          urgent ? 'bg-blue-600 text-white hover:bg-blue-700' : 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
        }`}
      >
        {busy && <Loader2 className="h-3 w-3 animate-spin" />}
        Complete
      </button>
    </li>
  )
}

function ActionButton({ label, href, onClick, busy, primary }: {
  label: string; href?: string; onClick?: () => void; busy?: boolean; primary?: boolean
}) {
  const cls = `inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold transition-colors disabled:cursor-wait disabled:opacity-70 ${FOCUS} ${
    primary
      ? 'bg-blue-600 text-white shadow-sm hover:bg-blue-700'
      : 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 hover:text-slate-900'
  }`
  const body = (
    <>
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : primary ? <Plus className="h-3.5 w-3.5" /> : null}
      {label}
    </>
  )
  return href
    ? <Link href={href} className={cls}>{body}</Link>
    : <button type="button" onClick={onClick} disabled={busy} className={cls}>{body}</button>
}
