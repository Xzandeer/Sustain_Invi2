'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { collection, onSnapshot, orderBy, query, limit } from 'firebase/firestore'
import { onAuthStateChanged } from 'firebase/auth'
import { doc, getDoc } from 'firebase/firestore'
import {
  AlertTriangle, BarChart3, Boxes, Calendar, ChevronDown,
  ChevronRight, ChevronUp, Package, PlusCircle, ShoppingCart,
  Sparkles, XCircle,
} from 'lucide-react'
import { auth, db } from '@/lib/firebase'
import ProtectedRoute from '@/components/shared/ProtectedRoute'
import type { LowStockItem } from '@/lib/server/salesInventoryMetrics'

// ── Types ─────────────────────────────────────────────────────────────────────

interface SaleDoc {
  id: string; receiptNumber?: string; customerName?: string
  items?: Array<Record<string, unknown>>
  totalAmount?: number; quantity?: number; createdAt?: unknown
}
interface InventoryDoc {
  id: string; name?: string; quantity?: number; minStock?: number
  category?: string; categoryName?: string; isDeleted?: boolean
}
interface ReservationDoc {
  id: string; reservationNumber?: string; customerName?: string
  items?: Array<Record<string, unknown>>
  status?: string; expiresAt?: unknown; createdAt?: unknown
}
interface StockLogDoc {
  id: string; actionType?: string; itemName?: string
  quantityChanged?: number; createdAt?: unknown
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

const formatCurrency = (n: number) =>
  `PHP ${n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const timeAgo = (d: Date | null): string => {
  if (!d) return ''
  const s = Math.floor((Date.now() - d.getTime()) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} hr ago`
  return `${Math.floor(s / 86400)}d ago`
}

// ── Page entry ────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  return <ProtectedRoute><DashboardContent /></ProtectedRoute>
}

// ── Main content ──────────────────────────────────────────────────────────────

function DashboardContent() {
  const [sales, setSales] = useState<SaleDoc[]>([])
  const [inventory, setInventory] = useState<InventoryDoc[]>([])
  const [reservations, setReservations] = useState<ReservationDoc[]>([])
  const [stockLogs, setStockLogs] = useState<StockLogDoc[]>([])
  const [loading, setLoading] = useState(true)
  const [userName, setUserName] = useState('User')
  const [now, setNow] = useState(new Date())

  // Live clock — ticks every minute
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(t)
  }, [])

  // Resolve logged-in user's display name from Firestore
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) return
      try {
        const snap = await getDoc(doc(db, 'users', user.uid))
        if (snap.exists()) {
          const d = snap.data() as Record<string, unknown>
          setUserName(
            typeof d.name === 'string' && d.name.trim() ? d.name.trim()
              : typeof d.email === 'string' ? (d.email as string).split('@')[0]
              : 'User'
          )
        }
      } catch (_) {}
    })
    return () => unsub()
  }, [])

  // Subscribe to all required Firestore collections in real time
  useEffect(() => {
    const unsubs = [
      onSnapshot(collection(db, 'inventory'), (snap) => {
        setInventory(snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as Omit<InventoryDoc, 'id'>), quantity: toNum((d.data() as Record<string,unknown>).stock ?? (d.data() as Record<string,unknown>).quantity) }))
          .filter((i) => i.isDeleted !== true))
        setLoading(false)
      }),
      onSnapshot(collection(db, 'sales'), (snap) => {
        setSales(snap.docs.map((d) => {
          const data = d.data() as Record<string, unknown>
          return {
            id: d.id,
            receiptNumber: typeof data.receiptNumber === 'string' ? data.receiptNumber : undefined,
            customerName: typeof data.customerName === 'string' ? data.customerName : typeof data.customer === 'string' ? data.customer : undefined,
            items: Array.isArray(data.items) ? data.items : [],
            totalAmount: toNum(data.totalAmount, toNum(data.total, toNum(data.amount))),
            quantity: toNum(data.quantity),
            createdAt: toDate(data.createdAt),
          }
        }))
      }),
      onSnapshot(query(collection(db, 'reservations'), orderBy('createdAt', 'desc')), (snap) => {
        setReservations(snap.docs.map((d) => {
          const data = d.data() as Record<string, unknown>
          return {
            id: d.id,
            reservationNumber: typeof data.reservationNumber === 'string' ? data.reservationNumber : undefined,
            customerName: typeof data.customerName === 'string' ? data.customerName : typeof data.customer === 'string' ? data.customer : undefined,
            items: Array.isArray(data.items) ? data.items : [],
            status: typeof data.status === 'string' ? data.status : 'Active',
            expiresAt: toDate(data.expiresAt),
            createdAt: toDate(data.createdAt),
          }
        }))
      }),
      onSnapshot(query(collection(db, 'stockLogs'), orderBy('createdAt', 'desc'), limit(20)), (snap) => {
        setStockLogs(snap.docs.map((d) => {
          const data = d.data() as Record<string, unknown>
          return {
            id: d.id,
            actionType: typeof data.actionType === 'string' ? data.actionType : '',
            itemName: typeof data.itemName === 'string' ? data.itemName : '',
            quantityChanged: toNum(data.quantityChanged),
            createdAt: toDate(data.createdAt),
          }
        }))
      }),
    ]
    return () => unsubs.forEach((u) => u())
  }, [])

  // ── KPI calculations ──────────────────────────────────────────────────────

  const thirtyDaysAgo = useMemo(() => { const d = new Date(); d.setDate(d.getDate() - 30); return d }, [])
  const sixtyDaysAgo  = useMemo(() => { const d = new Date(); d.setDate(d.getDate() - 60); return d }, [])

  const recentSales   = useMemo(() => sales.filter((s) => s.createdAt instanceof Date && (s.createdAt as Date) >= thirtyDaysAgo), [sales, thirtyDaysAgo])
  const previousSales = useMemo(() => sales.filter((s) => s.createdAt instanceof Date && (s.createdAt as Date) >= sixtyDaysAgo && (s.createdAt as Date) < thirtyDaysAgo), [sales, sixtyDaysAgo, thirtyDaysAgo])

  const totalSales      = useMemo(() => sales.reduce((s, x) => s + toNum(x.totalAmount), 0), [sales])
  const recentRevenue   = useMemo(() => recentSales.reduce((s, x) => s + toNum(x.totalAmount), 0), [recentSales])
  const previousRevenue = useMemo(() => previousSales.reduce((s, x) => s + toNum(x.totalAmount), 0), [previousSales])
  const revenueChange   = previousRevenue > 0 ? ((recentRevenue - previousRevenue) / previousRevenue) * 100 : null

  const countItems = (arr: SaleDoc[]) => arr.reduce((s, x) => {
    const c = Array.isArray(x.items) ? x.items.reduce((n, i) => n + Math.max(0, toNum(i.quantity)), 0) : Math.max(0, toNum(x.quantity))
    return s + c
  }, 0)

  const recentItemsSold   = useMemo(() => countItems(recentSales),   [recentSales])
  const previousItemsSold = useMemo(() => countItems(previousSales), [previousSales])
  const itemsSoldChange   = previousItemsSold > 0 ? ((recentItemsSold - previousItemsSold) / previousItemsSold) * 100 : null

  const productsInStock = useMemo(() => inventory.reduce((s, i) => s + Math.max(0, toNum(i.quantity)), 0), [inventory])

  const lowStockItems = useMemo<LowStockItem[]>(() =>
    inventory
      .filter((i) => toNum(i.quantity) <= toNum(i.minStock))
      .map((i) => ({ id: i.id, name: i.name?.trim() || i.id, categoryName: i.categoryName?.trim() || i.category?.trim() || 'Uncategorized', stock: toNum(i.quantity) })),
    [inventory])

  const outOfStockItems = useMemo(() => inventory.filter((i) => toNum(i.quantity) === 0), [inventory])

  // ── Top category for AI insight ───────────────────────────────────────────

  const topCategory = useMemo(() => {
    const rev: Record<string, number> = {}
    for (const s of sales) {
      for (const item of (s.items ?? [])) {
        const cat = typeof item.categoryName === 'string' ? item.categoryName : 'Uncategorized'
        rev[cat] = (rev[cat] ?? 0) + toNum(item.price) * toNum(item.quantity)
      }
    }
    const sorted = Object.entries(rev).sort((a, b) => b[1] - a[1])
    return sorted[0]?.[0] ?? null
  }, [sales])

  // ── Recent activity feed ──────────────────────────────────────────────────

  const recentActivity = useMemo(() => {
    type ActivityItem = { key: string; type: 'sale' | 'reservation' | 'stock'; label: string; sub: string; amount?: string; date: Date | null }
    const items: ActivityItem[] = []

    for (const s of [...sales].sort((a, b) => ((b.createdAt as Date)?.getTime() ?? 0) - ((a.createdAt as Date)?.getTime() ?? 0)).slice(0, 3)) {
      items.push({ key: `sale-${s.id}`, type: 'sale', label: 'Sale completed', sub: s.receiptNumber ? `Receipt #${s.receiptNumber}` : 'Sale record', amount: formatCurrency(toNum(s.totalAmount)), date: s.createdAt instanceof Date ? s.createdAt as Date : null })
    }
    for (const r of reservations.slice(0, 2)) {
      items.push({ key: `rsv-${r.id}`, type: 'reservation', label: 'Reservation created', sub: r.items?.[0] ? `Item: ${String(r.items[0].name ?? 'Unknown')}` : 'Reservation', date: r.createdAt instanceof Date ? r.createdAt as Date : null })
    }
    for (const log of stockLogs.slice(0, 2)) {
      if (!log.itemName) continue
      items.push({ key: `log-${log.id}`, type: 'stock', label: 'Stock updated', sub: log.itemName, amount: (log.quantityChanged ?? 0) > 0 ? `+${log.quantityChanged} pcs` : `${log.quantityChanged} pcs`, date: log.createdAt instanceof Date ? log.createdAt as Date : null })
    }

    return items.filter((i) => i.date !== null).sort((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0)).slice(0, 5)
  }, [sales, reservations, stockLogs])

  const upcomingReservations = useMemo(
    () => reservations.filter((r) => r.status === 'Active').slice(0, 3),
    [reservations]
  )

  // ── Formatted date / time ─────────────────────────────────────────────────

  const formattedDate = now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
  const formattedTime = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })

  // ── Render ────────────────────────────────────────────────────────────────


  return (
    <main className="min-h-[calc(100vh-64px)] bg-slate-50 px-3 py-3 sm:px-5 sm:py-5 space-y-3 sm:space-y-4">

      {/* ── Header ── */}
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
            </svg>
          </div>
          <div>
          <h1 className="text-lg font-bold text-slate-900 sm:text-2xl">Dashboard</h1>
          <p className="mt-0.5 text-xs text-slate-500 sm:text-sm">
            Welcome back,{' '}
            <span className="font-semibold text-blue-600">{userName}</span>!{' '}
            Here&apos;s what&apos;s happening with your store today.
          </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 text-sm text-slate-500">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
            </svg>
            <span>{formattedDate}</span>
            <span className="text-slate-300">·</span>
            <span className="font-medium text-slate-700">{formattedTime}</span>
          </div>
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[#1e3a5f] text-xs font-bold text-white ring-2 ring-white">
            {userName.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase()}
          </div>
        </div>
      </header>

      {/* ── KPI cards ── */}
      <section className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
        <KpiCard title="TOTAL SALES"           value={formatCurrency(totalSales)}       change={revenueChange}   icon={<svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" /></svg>} iconBg="bg-blue-100 text-blue-500"      loading={loading} />
        <KpiCard title="ITEMS SOLD"            value={recentItemsSold.toLocaleString()} change={itemsSoldChange} icon={<svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" /></svg>} iconBg="bg-emerald-100 text-emerald-500" loading={loading} />
        <KpiCard title="PRODUCTS IN STOCK"     value={productsInStock.toLocaleString()} change={null}            icon={<svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" /></svg>} iconBg="bg-violet-100 text-violet-500"  loading={loading} subtitle="All items available" />
        <KpiCard title="LOW STOCK"  value={String(lowStockItems.length)}     change={null}
          icon={<svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>}
          iconBg={lowStockItems.length > 0 ? 'bg-red-100 text-red-500' : 'bg-slate-100 text-slate-400'}
          danger={lowStockItems.length > 0}
          subtitle={lowStockItems.length > 0 ? 'Need attention' : 'All healthy'}
          loading={loading} />
      </section>

      {/* ── Middle row ── */}
      <section className="grid grid-cols-1 gap-2 sm:gap-3 lg:grid-cols-3">

        {/* Alerts & Warnings */}
        <div className="flex flex-col rounded-2xl border border-slate-200 bg-white p-3 sm:p-4 shadow-sm">
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-900">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber-50">
              <svg className="h-4 w-4 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" /></svg>
            </span>
            Alerts &amp; Warnings
          </h2>
          <div className="flex-1">
          {loading ? <Skeleton rows={2} /> : (
            <div className="space-y-2.5">
              {lowStockItems.length > 0 && <AlertRow type="warning" label={`Low Stock (${lowStockItems.length})`} desc="Some categories are running low." items={lowStockItems.map((i) => ({ name: i.categoryName, note: `${i.stock} left` }))} />}
              {outOfStockItems.length > 0 && <AlertRow type="danger" label={`Out of Stock (${outOfStockItems.length})`} desc="Some items are out of stock." items={outOfStockItems.map((i) => ({ name: i.name ?? i.id, note: 'Out of stock' }))} />}
              {lowStockItems.length === 0 && outOfStockItems.length === 0 && (
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2.5">
                  <p className="text-sm font-medium text-emerald-700">✓ All inventory levels are healthy</p>
                </div>
              )}
            </div>
          )}
          </div>
          <div className="mt-auto border-t border-slate-100 pt-2">
            <Link href="/inventory" className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-500">
              View all alerts
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M17 8l4 4m0 0l-4 4m4-4H3" /></svg>
            </Link>
          </div>
        </div>

        {/* Quick Actions */}
        <div className="rounded-2xl border border-slate-200 bg-white p-3 sm:p-4 shadow-sm">
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-900">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-50">
              <svg className="h-4 w-4 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
            </span>
            Quick Actions
          </h2>
          <div className="grid grid-cols-2 gap-2">
            <QuickAction href="/sales"        label="New Sale"          color="bg-blue-50 text-blue-600 hover:bg-blue-100"       icon={<svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" /></svg>} />
            <QuickAction href="/inventory"    label="View Inventory"    color="bg-emerald-50 text-emerald-600 hover:bg-emerald-100" icon={<svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" /></svg>} />
            <QuickAction href="/analytics"    label="View Analytics"    color="bg-violet-50 text-violet-600 hover:bg-violet-100"  icon={<svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>} />
            <QuickAction href="/reservations" label="View Reservations" color="bg-amber-50 text-amber-600 hover:bg-amber-100"    icon={<svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>} />
          </div>
        </div>

        {/* Insight (not AI) */}
        <div className="rounded-2xl border border-slate-200 bg-white p-3 sm:p-4 shadow-sm">
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-900">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-violet-50">
              <svg className="h-4 w-4 text-violet-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" /></svg>
            </span>
            Insight
          </h2>
          <div className="rounded-xl border border-violet-100 bg-violet-50 p-3 space-y-1">
            {topCategory ? (
              <>
                <p className="text-sm font-semibold text-violet-900 leading-snug">
                  {topCategory} is currently the strongest category based on recent sales.
                </p>
                <p className="text-xs text-violet-600">
                  Consider increasing display and stock allocation for this category.
                </p>
              </>
            ) : (
              <p className="text-sm text-violet-700">Not enough sales data to generate insights yet.</p>
            )}
          </div>
          <Link href="/analytics" className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-500">
            View full analytics
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M17 8l4 4m0 0l-4 4m4-4H3" /></svg>
          </Link>
        </div>
      </section>

      {/* ── Bottom row ── */}
      <section className="grid grid-cols-1 gap-2 sm:gap-3 lg:grid-cols-2">

        {/* Recent Activity */}
        <div className="flex flex-col rounded-2xl border border-slate-200 bg-white p-3 sm:p-4 shadow-sm">
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-900">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-slate-100">
              <svg className="h-4 w-4 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>
            </span>
            Recent Activity
          </h2>
          <div className="flex-1">
          {loading ? <Skeleton rows={3} /> : recentActivity.length === 0 ? (
            <p className="text-sm text-slate-400">No recent activity yet.</p>
          ) : (
            <ul className="divide-y divide-slate-50">
              {recentActivity.map((item) => (
                <li key={item.key} className="flex items-center gap-3 py-2">
                  <span className={`flex h-8 w-8 sm:h-9 sm:w-9 shrink-0 items-center justify-center rounded-full text-white ${
                    item.type === 'sale' ? 'bg-emerald-500' : item.type === 'reservation' ? 'bg-amber-500' : 'bg-blue-500'
                  }`}>
                    {item.type === 'sale'
                      ? <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" /></svg>
                      : item.type === 'reservation'
                      ? <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                      : <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" /></svg>
                    }
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-slate-800">{item.label}</p>
                    <p className="truncate text-xs text-slate-400">{item.sub}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    {item.amount && (
                      <p className={`text-sm font-semibold ${item.type === 'sale' ? 'text-emerald-600' : 'text-slate-700'}`}>
                        {item.amount}
                      </p>
                    )}
                    <p className="text-xs text-slate-400">{timeAgo(item.date)}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
          </div>
          <div className="mt-auto border-t border-slate-100 pt-2">
            <Link href="/sales" className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-500">
              View all activity
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M17 8l4 4m0 0l-4 4m4-4H3" /></svg>
            </Link>
          </div>
        </div>

        {/* Upcoming Reservations */}
        <div className="flex flex-col rounded-2xl border border-slate-200 bg-white p-3 sm:p-4 shadow-sm">
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-900">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber-50">
              <svg className="h-4 w-4 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
            </span>
            Upcoming Reservations
          </h2>
          <div className="flex-1">
          {loading ? <Skeleton rows={3} /> : upcomingReservations.length === 0 ? (
            <p className="text-sm text-slate-400">No active reservations.</p>
          ) : (
            <ul className="divide-y divide-slate-50">
              {upcomingReservations.map((r) => {
                const exp = r.expiresAt instanceof Date ? r.expiresAt as Date : null
                const firstItem = r.items?.[0]
                return (
                  <li key={r.id} className="flex items-center gap-3 py-2">
                    <span className="flex h-8 w-8 sm:h-9 sm:w-9 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-600">
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-slate-800 truncate">{r.customerName ?? 'Unknown Customer'}</p>
                      <p className="text-xs text-slate-400 truncate">
                        {firstItem ? String(firstItem.name ?? 'Item') : 'Item'}
                        {r.items && r.items.length > 1 ? ` +${r.items.length - 1} more` : ''}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <span className="inline-block rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-700">Active</span>
                      {exp && (
                        <p className="mt-0.5 text-xs text-slate-400">
                          Expires {exp.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        </p>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
          </div>
          <div className="mt-auto border-t border-slate-100 pt-2">
            <Link href="/reservations" className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-500">
              View all reservations
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M17 8l4 4m0 0l-4 4m4-4H3" /></svg>
            </Link>
          </div>
        </div>
      </section>
    </main>
  )
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function KpiCard({ title, value, change, icon, iconBg, danger = false, subtitle, loading = false }:
  { title: string; value: string; change: number | null; icon: React.ReactNode; iconBg: string; danger?: boolean; subtitle?: string; loading?: boolean }) {
  return (
    <article className={`rounded-2xl border p-3 sm:p-4 shadow-sm ${danger ? 'border-red-200 bg-red-50' : 'border-slate-200 bg-white'}`}>
      {/* Icon */}
      <div className={`flex h-9 w-9 items-center justify-center rounded-xl ${iconBg} mb-2`}>
        {icon}
      </div>
      {/* Label */}
      <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 leading-tight">{title}</p>
      {/* Value */}
      {loading
        ? <div className="mt-1 h-6 w-16 animate-pulse rounded bg-slate-200" />
        : <p className={`mt-0.5 text-xl font-bold leading-tight sm:text-2xl ${danger ? 'text-red-700' : 'text-slate-900'}`}>{value}</p>
      }
      {/* Change badge */}
      {!loading && change !== null && (
        <span className={`mt-1 inline-flex items-center gap-0.5 text-[10px] font-medium ${change >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
          {change >= 0
            ? <svg className="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" /></svg>
            : <svg className="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
          }
          {Math.abs(change).toFixed(1)}% <span className="hidden sm:inline">vs last 30 days</span><span className="sm:hidden">30d</span>
        </span>
      )}
      {!loading && subtitle && change === null && (
        <p className={`mt-0.5 text-[10px] sm:text-xs ${danger ? 'text-red-500 font-medium' : 'text-slate-400'}`}>{subtitle}</p>
      )}
    </article>
  )
}

function QuickAction({ href, icon, label, color }: { href: string; icon: React.ReactNode; label: string; color: string }) {
  return (
    <Link href={href} className={`flex flex-col items-center justify-center gap-1.5 rounded-xl p-3 sm:p-4 text-center transition ${color}`}>
      {icon}
      <span className="text-[11px] font-semibold leading-tight">{label}</span>
    </Link>
  )
}

function AlertRow({ type, label, desc, items }: { type: 'warning' | 'danger'; label: string; desc: string; items: { name: string; note: string }[] }) {
  const [open, setOpen] = useState(false)
  const isWarn = type === 'warning'
  return (
    <div className={`rounded-xl border px-4 py-3 ${isWarn ? 'border-amber-200 bg-amber-50' : 'border-red-200 bg-red-50'}`}>
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-left">
          {isWarn
            ? <svg className="h-4 w-4 shrink-0 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
            : <svg className="h-4 w-4 shrink-0 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
          }
          <div>
            <p className={`text-sm font-semibold ${isWarn ? 'text-amber-800' : 'text-red-800'}`}>{label}</p>
            <p className={`text-xs ${isWarn ? 'text-amber-600' : 'text-red-600'}`}>{desc}</p>
          </div>
        </div>
        <svg className={`h-4 w-4 shrink-0 transition-transform ${open ? 'rotate-180' : ''} ${isWarn ? 'text-amber-500' : 'text-red-500'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
      </button>
      {open && (
        <ul className="mt-2.5 space-y-1 border-t border-dashed border-current border-opacity-20 pt-2.5">
          {items.map((item, i) => (
            <li key={i} className="flex items-center justify-between text-xs">
              <span className={isWarn ? 'text-amber-800' : 'text-red-800'}>• {item.name}</span>
              <span className={`font-medium ${isWarn ? 'text-amber-600' : 'text-red-600'}`}>{item.note}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Skeleton({ rows }: { rows: number }) {
  return (
    <div className="space-y-2.5">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-12 animate-pulse rounded-xl bg-slate-100" />
      ))}
    </div>
  )
}
