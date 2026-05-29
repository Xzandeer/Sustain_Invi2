'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { collection, onSnapshot, orderBy, query, limit } from 'firebase/firestore'
import { onAuthStateChanged } from 'firebase/auth'
import { doc, getDoc } from 'firebase/firestore'
import {
  ChevronRight, TrendingUp, TrendingDown,
  AlertTriangle, Package, Bookmark, LayoutGrid, ShoppingCart, Calendar,
  BarChart3, ClipboardList, UserCheck, PackagePlus,
} from 'lucide-react'
import {
  Chart as ChartJS,
  CategoryScale, LinearScale, PointElement,
  LineElement, Filler, Tooltip,
} from 'chart.js'
import { Line } from 'react-chartjs-2'
import { auth, db } from '@/lib/firebase'
import ProtectedRoute from '@/components/shared/ProtectedRoute'
import type { LowStockItem } from '@/lib/server/salesInventoryMetrics'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip)

// ── Types ─────────────────────────────────────────────────────────────────────

interface SaleDoc {
  id: string; receiptNumber?: string; customerName?: string
  items?: Array<Record<string, unknown>>
  totalAmount?: number; quantity?: number; createdAt?: unknown
  status?: string
}
interface InventoryDoc {
  id: string; name?: string; quantity?: number; minStock?: number
  price?: number; reservedStock?: number
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

const fmt = (n: number) =>
  `₱${n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const fmtK = (n: number): string => {
  if (n >= 1_000_000) return `₱${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `₱${(n / 1_000).toFixed(0)}K`
  return `₱${n.toFixed(0)}`
}

// Axis-safe formatter — never rounds 1,200 to "₱1K" or 1,600 to "₱2K"
const fmtAxis = (n: number): string => {
  if (n === 0) return '₱0'
  if (n >= 1_000_000) { const v = n / 1_000_000; return `₱${v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)}M` }
  if (n >= 1_000)     { const v = n / 1_000;     return `₱${v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)}K` }
  return `₱${n.toFixed(0)}`
}

const timeAgo = (d: Date | null): string => {
  if (!d) return ''
  const s = Math.floor((Date.now() - d.getTime()) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

// ── Sparkline ─────────────────────────────────────────────────────────────────

function Sparkline({ values, stroke, fill }: { values: number[]; stroke: string; fill: string }) {
  if (values.length < 2) {
    return <svg width="100" height="40" viewBox="0 0 100 40"><line x1="0" y1="20" x2="100" y2="20" stroke={stroke} strokeWidth="1.5" strokeOpacity="0.4" /></svg>
  }
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const W = 100, H = 40, pad = 2
  const pts = values.map((v, i) => [
    pad + (i / (values.length - 1)) * (W - pad * 2),
    H - pad - ((v - min) / range) * (H - pad * 2 - 6),
  ])
  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${H} L${pts[0][0].toFixed(1)},${H} Z`
  return (
    <svg width="100" height="40" viewBox="0 0 100 40">
      <path d={area} fill={fill} />
      <path d={line} fill="none" stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// ── Sales Chart (Chart.js — matches Analytics page style) ────────────────────

function SalesChart({ data }: { data: { date: Date; revenue: number }[] }) {
  const labels = data.map(d =>
    d.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  )
  const values = data.map(d => d.revenue)

  return (
    <div className="h-48">
      <Line
        data={{
          labels,
          datasets: [
            {
              label: 'Revenue',
              data: values,
              fill: true,
              borderColor: '#0f4c81',
              backgroundColor: 'rgba(15,76,129,0.07)',
              borderWidth: 2,
              pointRadius: 3,
              pointHoverRadius: 5,
              tension: 0.35,
            },
          ],
        }}
        options={{
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: (ctx) => `Revenue: ${fmt(Number(ctx.parsed.y ?? 0))}`,
              },
            },
          },
          scales: {
            x: {
              grid: { display: false },
              ticks: { font: { size: 11 }, color: '#94a3b8' },
            },
            y: {
              beginAtZero: true,
              grid: { color: '#f1f5f9' },
              ticks: {
                font: { size: 11 },
                color: '#94a3b8',
                callback: (value) => fmtAxis(Number(value)),
              },
            },
          },
        }}
      />
    </div>
  )
}

// ── Page entry ────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  return <ProtectedRoute><DashboardContent /></ProtectedRoute>
}

// ── Main content ──────────────────────────────────────────────────────────────

function DashboardContent() {
  const [sales, setSales]               = useState<SaleDoc[]>([])
  const [inventory, setInventory]       = useState<InventoryDoc[]>([])
  const [reservations, setReservations] = useState<ReservationDoc[]>([])
  const [stockLogs, setStockLogs]       = useState<StockLogDoc[]>([])
  const [loading, setLoading]           = useState(true)
  const [userName, setUserName]         = useState('User')
  const [userInitials, setUserInitials] = useState('U')
  const [now, setNow]                   = useState(new Date())
  const [chartPeriod, setChartPeriod]   = useState<7 | 14 | 30 | 90>(30)
  const [showPeriodMenu, setShowPeriodMenu] = useState(false)

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) return
      try {
        const snap = await getDoc(doc(db, 'users', user.uid))
        if (snap.exists()) {
          const d = snap.data() as Record<string, unknown>
          const name = typeof d.name === 'string' && d.name.trim() ? d.name.trim()
            : typeof d.email === 'string' ? (d.email as string).split('@')[0] : 'User'
          setUserName(name)
          setUserInitials(name.split(' ').map((n: string) => n[0]).join('').slice(0, 2).toUpperCase())
        }
      } catch (_) {}
    })
    return () => unsub()
  }, [])

  useEffect(() => {
    const unsubs = [
      onSnapshot(collection(db, 'inventory'), snap => {
        setInventory(snap.docs.map(d => {
          const data = d.data() as Record<string, unknown>
          return {
            id: d.id,
            name: String(data.name ?? ''),
            quantity: toNum(data.stock ?? data.quantity),
            minStock: toNum(data.minStock),
            price: toNum(data.price),
            reservedStock: toNum(data.reservedStock),
            categoryName: String(data.categoryName ?? data.category ?? ''),
            isDeleted: data.isDeleted === true,
          }
        }).filter(i => !i.isDeleted))
        setLoading(false)
      }),
      onSnapshot(collection(db, 'sales'), snap => {
        setSales(snap.docs.map(d => {
          const data = d.data() as Record<string, unknown>
          return {
            id: d.id,
            receiptNumber: typeof data.receiptNumber === 'string' ? data.receiptNumber : undefined,
            customerName: typeof data.customer === 'string' ? data.customer : typeof data.customerName === 'string' ? data.customerName : undefined,
            items: Array.isArray(data.items) ? data.items : [],
            totalAmount: toNum(data.totalAmount),
            status: String(data.status ?? 'completed'),
            createdAt: toDate(data.createdAt),
          }
        }))
      }),
      onSnapshot(query(collection(db, 'reservations'), orderBy('createdAt', 'desc')), snap => {
        setReservations(snap.docs.map(d => {
          const data = d.data() as Record<string, unknown>
          return {
            id: d.id,
            customerName: typeof data.customer === 'string' ? data.customer : typeof data.customerName === 'string' ? data.customerName : undefined,
            items: Array.isArray(data.items) ? data.items : [],
            status: String(data.status ?? 'Active'),
            expiresAt: toDate(data.expiresAt),
            createdAt: toDate(data.createdAt),
          }
        }))
      }),
      onSnapshot(query(collection(db, 'stockLogs'), orderBy('createdAt', 'desc'), limit(20)), snap => {
        setStockLogs(snap.docs.map(d => {
          const data = d.data() as Record<string, unknown>
          return {
            id: d.id,
            actionType: String(data.actionType ?? ''),
            itemName: String(data.itemName ?? ''),
            quantityChanged: toNum(data.quantityChanged),
            createdAt: toDate(data.createdAt),
          }
        }))
      }),
    ]
    return () => unsubs.forEach(u => u())
  }, [])

  // ── KPI computations ──────────────────────────────────────────────────────

  const thirtyDaysAgo = useMemo(() => { const d = new Date(); d.setDate(d.getDate() - 30); return d }, [])
  const sixtyDaysAgo  = useMemo(() => { const d = new Date(); d.setDate(d.getDate() - 60); return d }, [])

  const completedSales = useMemo(() => sales.filter(s => s.status !== 'voided'), [sales])
  const recentSales    = useMemo(() => completedSales.filter(s => {
    const d = toDate(s.createdAt); return d && d >= thirtyDaysAgo
  }), [completedSales, thirtyDaysAgo])
  const previousSales  = useMemo(() => completedSales.filter(s => {
    const d = toDate(s.createdAt); return d && d >= sixtyDaysAgo && d < thirtyDaysAgo
  }), [completedSales, sixtyDaysAgo, thirtyDaysAgo])

  const totalRevenue   = useMemo(() => completedSales.reduce((s, x) => s + toNum(x.totalAmount), 0), [completedSales])
  const recentRevenue  = useMemo(() => recentSales.reduce((s, x) => s + toNum(x.totalAmount), 0), [recentSales])
  const prevRevenue    = useMemo(() => previousSales.reduce((s, x) => s + toNum(x.totalAmount), 0), [previousSales])
  const revenueChange  = prevRevenue > 0 ? ((recentRevenue - prevRevenue) / prevRevenue) * 100 : null

  const recentSaleCount  = recentSales.length
  const prevSaleCount    = previousSales.length
  const saleCountChange  = prevSaleCount > 0 ? ((recentSaleCount - prevSaleCount) / prevSaleCount) * 100 : null

  const inventoryValue   = useMemo(() => inventory.reduce((s, i) => s + toNum(i.price) * Math.max(0, toNum(i.quantity)), 0), [inventory])
  const lowStockItems    = useMemo<LowStockItem[]>(() =>
    inventory.filter(i => toNum(i.quantity) > 0 && toNum(i.quantity) <= toNum(i.minStock))
      .map(i => ({ id: i.id, name: i.name?.trim() || i.id, categoryName: i.categoryName?.trim() || 'Uncategorized', stock: toNum(i.quantity) })),
    [inventory])
  const outOfStockItems  = useMemo(() => inventory.filter(i => toNum(i.quantity) === 0), [inventory])
  const reservedCount    = useMemo(() => inventory.reduce((s, i) => s + toNum(i.reservedStock), 0), [inventory])
  const totalStock       = useMemo(() => inventory.reduce((s, i) => s + Math.max(0, toNum(i.quantity)), 0), [inventory])

  const alertCount = lowStockItems.length + outOfStockItems.length

  // ── Sparkline data (14 days) ──────────────────────────────────────────────

  const buildDailyBuckets = (n: number) => Array.from({ length: n }, (_, i) => {
    const d = new Date(); d.setDate(d.getDate() - (n - 1 - i)); d.setHours(0, 0, 0, 0); return d
  })

  const revenueSparkline = useMemo(() => {
    const buckets = buildDailyBuckets(14).map(() => 0)
    for (const s of completedSales) {
      const d = toDate(s.createdAt); if (!d) continue
      const daysAgo = Math.floor((Date.now() - d.getTime()) / 86400000)
      if (daysAgo >= 0 && daysAgo < 14) buckets[13 - daysAgo] += toNum(s.totalAmount)
    }
    return buckets
  }, [completedSales])

  const salesSparkline = useMemo(() => {
    const buckets = buildDailyBuckets(14).map(() => 0)
    for (const s of completedSales) {
      const d = toDate(s.createdAt); if (!d) continue
      const daysAgo = Math.floor((Date.now() - d.getTime()) / 86400000)
      if (daysAgo >= 0 && daysAgo < 14) buckets[13 - daysAgo]++
    }
    return buckets
  }, [completedSales])

  const inventorySparkline = useMemo(() =>
    buildDailyBuckets(14).map(() => inventoryValue),
  [inventoryValue])

  // ── Sales chart (30 days) ─────────────────────────────────────────────────

  const salesChartData = useMemo(() => {
    const days = buildDailyBuckets(chartPeriod)
    const buckets = days.map(date => ({ date, revenue: 0 }))
    for (const s of completedSales) {
      const d = toDate(s.createdAt); if (!d) continue
      const daysAgo = Math.floor((Date.now() - d.getTime()) / 86400000)
      if (daysAgo >= 0 && daysAgo < chartPeriod) buckets[chartPeriod - 1 - daysAgo].revenue += toNum(s.totalAmount)
    }
    return buckets
  }, [completedSales, chartPeriod])

  // ── Average order value ───────────────────────────────────────────────────

  const avgOrderValue    = recentSaleCount > 0 ? recentRevenue / recentSaleCount : 0
  const prevAvgOrder     = prevSaleCount   > 0 ? prevRevenue   / prevSaleCount   : 0
  const avgOrderChange   = prevAvgOrder    > 0 ? ((avgOrderValue - prevAvgOrder) / prevAvgOrder) * 100 : null

  // ── Top selling products ──────────────────────────────────────────────────

  const topProducts = useMemo(() => {
    const map: Record<string, { name: string; sold: number; revenue: number }> = {}
    for (const s of completedSales) {
      for (const item of (s.items ?? [])) {
        const name = String(item.name ?? '').trim(); if (!name) continue
        if (!map[name]) map[name] = { name, sold: 0, revenue: 0 }
        map[name].sold    += toNum(item.quantity)
        map[name].revenue += toNum(item.quantity) * toNum(item.price)
      }
    }
    return Object.values(map).sort((a, b) => b.sold - a.sold).slice(0, 5)
  }, [completedSales])

  // ── Top category ─────────────────────────────────────────────────────────

  const topCategory = useMemo(() => {
    const rev: Record<string, number> = {}
    for (const s of completedSales) {
      for (const item of (s.items ?? [])) {
        const cat = String(item.categoryName ?? 'Uncategorized')
        rev[cat] = (rev[cat] ?? 0) + toNum(item.price) * toNum(item.quantity)
      }
    }
    return Object.entries(rev).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  }, [completedSales])

  // ── Recent activity ───────────────────────────────────────────────────────

  const recentActivity = useMemo(() => {
    type Activity = { key: string; type: 'sale' | 'reservation' | 'stock'; label: string; sub: string; amount?: string; date: Date | null }
    const items: Activity[] = []
    for (const s of [...completedSales].sort((a, b) => ((toDate(b.createdAt)?.getTime() ?? 0) - (toDate(a.createdAt)?.getTime() ?? 0))).slice(0, 4))
      items.push({ key: `s-${s.id}`, type: 'sale', label: 'Sale completed', sub: s.receiptNumber ? `#${s.receiptNumber}` : 'Receipt', amount: fmt(toNum(s.totalAmount)), date: toDate(s.createdAt) })
    for (const r of reservations.slice(0, 2))
      items.push({ key: `r-${r.id}`, type: 'reservation', label: 'Reservation created', sub: r.items?.[0] ? String(r.items[0].name ?? 'Item') : 'Item', date: toDate(r.createdAt) })
    for (const l of stockLogs.slice(0, 3)) {
      if (!l.itemName) continue
      items.push({ key: `l-${l.id}`, type: 'stock', label: 'Stock updated', sub: l.itemName, amount: (l.quantityChanged ?? 0) >= 0 ? `+${l.quantityChanged}` : String(l.quantityChanged), date: toDate(l.createdAt) })
    }
    return items.filter(i => i.date).sort((a, b) => (b.date!.getTime() - a.date!.getTime())).slice(0, 4)
  }, [completedSales, reservations, stockLogs])

  // ── Date range display ────────────────────────────────────────────────────

  const greeting = useMemo(() => {
    const h = now.getHours()
    return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
  }, [now])

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex min-h-screen flex-col bg-[#f5f6fa]">

      {/* ── Top Bar ── */}
      <header className="flex items-center justify-between gap-4 bg-white px-5 py-2.5 border-b border-gray-100">
        <div>
          <div className="flex items-center gap-1.5">
            <h1 className="text-base font-bold text-gray-900">{greeting}, {userName}</h1>
            <span>👋</span>
          </div>
          <p className="text-[11px] text-gray-400">
            {now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          {/* User avatar */}
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-blue-600 to-indigo-600 text-xs font-bold text-white">
            {userInitials}
          </div>
        </div>
      </header>

      {/* ── Page body ── */}
      <div className="flex-1 p-3 space-y-2">

        {/* ── KPI Cards ── */}
        <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
          <KpiCard
            title="Total Revenue"
            value={fmt(totalRevenue)}
            change={revenueChange}
            subtitle="vs last 30 days"
            spark={<Sparkline values={revenueSparkline} stroke="#3b82f6" fill="rgba(59,130,246,0.1)" />}
            loading={loading}
            iconBg="bg-blue-100"
            icon={<svg className="h-4 w-4 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>}
          />
          <KpiCard
            title="Total Sales"
            value={String(recentSaleCount)}
            change={saleCountChange}
            subtitle="vs last 30 days"
            spark={<Sparkline values={salesSparkline} stroke="#10b981" fill="rgba(16,185,129,0.1)" />}
            loading={loading}
            iconBg="bg-emerald-100"
            icon={<svg className="h-4 w-4 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z" /></svg>}
          />
          <KpiCard
            title="Inventory Value"
            value={fmt(inventoryValue)}
            subtitle={`${inventory.length} product lines`}
            spark={<Sparkline values={inventorySparkline} stroke="#8b5cf6" fill="rgba(139,92,246,0.1)" />}
            loading={loading}
            iconBg="bg-violet-100"
            icon={<svg className="h-4 w-4 text-violet-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" /></svg>}
          />
          <KpiCard
            title="Low Stock Alerts"
            value={String(alertCount)}
            subtitle={`${outOfStockItems.length} out of stock`}
            loading={loading}
            iconBg={alertCount > 0 ? 'bg-red-100' : 'bg-gray-100'}
            icon={<svg className={`h-4 w-4 ${alertCount > 0 ? 'text-red-500' : 'text-gray-400'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>}
          />
        </div>

        {/* ── Middle row ── */}
        <div className="grid grid-cols-1 gap-2 xl:grid-cols-3">

          {/* Sales Overview */}
          <div className="xl:col-span-2 rounded-2xl bg-white p-3 shadow-sm border border-gray-100">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-bold text-gray-800">Sales Overview</h2>
              <div className="relative flex items-center gap-2">
                <span className="flex items-center gap-1 rounded-lg border border-gray-200 px-2.5 py-1 text-xs font-medium text-gray-500 bg-gray-50">
                  Revenue
                </span>
                <button
                  onClick={() => setShowPeriodMenu(v => !v)}
                  className="flex items-center gap-1 rounded-lg border border-blue-200 bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-600 hover:bg-blue-100 transition-colors"
                >
                  Last {chartPeriod} days <ChevronRight className={`h-3 w-3 transition-transform ${showPeriodMenu ? 'rotate-[270deg]' : 'rotate-90'}`} />
                </button>
                {showPeriodMenu && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setShowPeriodMenu(false)} />
                    <div className="absolute right-0 top-full z-50 mt-1.5 w-40 overflow-hidden rounded-xl border border-gray-100 bg-white shadow-lg">
                      {([7, 14, 30, 90] as const).map(p => (
                        <button key={p} onClick={() => { setChartPeriod(p); setShowPeriodMenu(false) }}
                          className={`flex w-full items-center justify-between px-3.5 py-2 text-sm transition-colors ${
                            chartPeriod === p ? 'bg-blue-50 font-semibold text-blue-600' : 'text-gray-700 hover:bg-gray-50'
                          }`}>
                          Last {p} days
                          {chartPeriod === p && <span className="text-blue-500 text-xs">✓</span>}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>
            {loading
              ? <div className="h-48 w-full animate-pulse rounded-xl bg-gray-50" />
              : <SalesChart data={salesChartData} />
            }
            {/* Summary row */}
            <div className="mt-2 grid grid-cols-3 gap-2 border-t border-gray-100 pt-2">
              <div>
                <p className="text-[11px] text-gray-400">Revenue</p>
                <p className="mt-0.5 text-sm font-bold text-gray-900">{fmt(recentRevenue)}</p>
                {revenueChange != null && <ChangeBadge v={revenueChange} />}
              </div>
              <div>
                <p className="text-[11px] text-gray-400">Orders</p>
                <p className="mt-0.5 text-sm font-bold text-gray-900">{recentSaleCount}</p>
                {saleCountChange != null && <ChangeBadge v={saleCountChange} />}
              </div>
              <div>
                <p className="text-[11px] text-gray-400">Avg Order Value</p>
                <p className="mt-0.5 text-sm font-bold text-gray-900">{fmt(avgOrderValue)}</p>
                {avgOrderChange != null && <ChangeBadge v={avgOrderChange} />}
              </div>
            </div>
          </div>

          {/* Inventory Status */}
          <div className="flex flex-col rounded-2xl bg-white p-3 shadow-sm border border-gray-100">
            <div className="mb-1 flex items-center justify-between">
              <h2 className="text-sm font-bold text-gray-800">Inventory Status</h2>
              <Link href="/inventory" className="text-xs font-medium text-blue-600 hover:underline">View all</Link>
            </div>
            <div className="flex flex-col flex-1 divide-y divide-gray-50">
              <InventoryStatusRow
                iconEl={<AlertTriangle className="h-4 w-4 text-amber-600" />}
                iconBg="bg-amber-100"
                label="Low Stock"
                desc="Items running below minimum"
                count={lowStockItems.length}
                href="/inventory"
              />
              <InventoryStatusRow
                iconEl={<Package className="h-4 w-4 text-red-500" />}
                iconBg="bg-red-100"
                label="Out of Stock"
                desc="Items need restocking"
                count={outOfStockItems.length}
                href="/inventory"
              />
              <InventoryStatusRow
                iconEl={<Bookmark className="h-4 w-4 text-blue-500" />}
                iconBg="bg-blue-100"
                label="Reserved Items"
                desc="Items in active reservations"
                count={reservedCount}
                href="/reservations"
              />
              <InventoryStatusRow
                iconEl={<LayoutGrid className="h-4 w-4 text-purple-500" />}
                iconBg="bg-purple-100"
                label="Total Products"
                desc={`Across ${inventory.length} product lines`}
                count={totalStock}
                href="/inventory"
              />
            </div>
          </div>
        </div>

        {/* ── Bottom row ── */}
        <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">

          {/* Recent Activity */}
          <div className="rounded-2xl bg-white p-3 shadow-sm border border-gray-100">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-bold text-gray-800">Recent Activity</h2>
              <Link href="/sales" className="text-xs font-medium text-blue-600 hover:underline">View all</Link>
            </div>
            {loading ? <PulseRows n={5} /> : recentActivity.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-10 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-gray-100">
                  <Package className="h-5 w-5 text-gray-300" />
                </div>
                <p className="text-sm text-gray-400">No recent activity yet.</p>
              </div>
            ) : (
              <div className="divide-y divide-gray-50">
                {recentActivity.map(item => {
                  const iconMap = {
                    sale:        { el: <ShoppingCart className="h-4 w-4 text-emerald-600" />, bg: 'bg-emerald-100' },
                    reservation: { el: <Calendar className="h-4 w-4 text-amber-600" />,      bg: 'bg-amber-100' },
                    stock:       { el: <Package className="h-4 w-4 text-blue-500" />,         bg: 'bg-blue-100' },
                  }
                  const { el, bg } = iconMap[item.type]
                  return (
                    <div key={item.key} className="flex items-center gap-2.5 py-2">
                      <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${bg}`}>
                        {el}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-semibold text-gray-800">{item.label}</p>
                        <p className="truncate text-[11px] text-gray-400">{item.sub}</p>
                      </div>
                      <div className="shrink-0 text-right">
                        {item.amount && (
                          <p className={`text-xs font-bold ${
                            item.type === 'sale' ? 'text-emerald-600'
                            : item.type === 'stock' ? 'text-blue-600'
                            : 'text-gray-700'
                          }`}>
                            {item.type === 'stock' ? `${item.amount} pcs` : item.amount}
                          </p>
                        )}
                        <p className="text-[11px] text-gray-400">{timeAgo(item.date)}</p>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Quick Actions */}
          <div className="rounded-2xl bg-white p-3 shadow-sm border border-gray-100">
            <h2 className="mb-2 text-sm font-bold text-gray-800">Quick Actions</h2>
            <div className="grid grid-cols-2 gap-2">
              <QuickAction
                href="/sales"
                icon={<ShoppingCart className="h-4 w-4" />}
                label="New Sale"
                desc="Process a transaction"
                iconBg="bg-blue-100"
                iconColor="text-blue-600"
                hoverBg="hover:bg-blue-50"
              />
              <QuickAction
                href="/inventory"
                icon={<PackagePlus className="h-5 w-5" />}
                label="Add Item"
                desc="Add to inventory"
                iconBg="bg-emerald-100"
                iconColor="text-emerald-600"
                hoverBg="hover:bg-emerald-50"
              />
              <QuickAction
                href="/reservations"
                icon={<Calendar className="h-5 w-5" />}
                label="Reserve"
                desc="New reservation"
                iconBg="bg-amber-100"
                iconColor="text-amber-600"
                hoverBg="hover:bg-amber-50"
              />
              <QuickAction
                href="/customers"
                icon={<UserCheck className="h-5 w-5" />}
                label="Customers"
                desc="View customers"
                iconBg="bg-pink-100"
                iconColor="text-pink-600"
                hoverBg="hover:bg-pink-50"
              />
              <QuickAction
                href="/analytics"
                icon={<BarChart3 className="h-5 w-5" />}
                label="Analytics"
                desc="Sales & trends"
                iconBg="bg-violet-100"
                iconColor="text-violet-600"
                hoverBg="hover:bg-violet-50"
              />
              <QuickAction
                href="/inventory/logs"
                icon={<ClipboardList className="h-5 w-5" />}
                label="Stock Logs"
                desc="Audit trail"
                iconBg="bg-gray-100"
                iconColor="text-gray-500"
                hoverBg="hover:bg-gray-50"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function KpiCard({ title, value, change, subtitle, spark, icon, iconBg, loading }: {
  title: string; value: string; change?: number | null; subtitle?: string
  spark?: React.ReactNode; icon: React.ReactNode; iconBg: string; loading?: boolean
}) {
  return (
    <div className="rounded-xl border border-gray-100 bg-white p-3 shadow-sm">
      {/* Top row: icon + title | change badge */}
      <div className="flex items-center gap-2">
        <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${iconBg}`}>
          {icon}
        </div>
        <div className="flex min-w-0 flex-1 items-center justify-between gap-1.5">
          <p className="truncate text-xs font-medium text-gray-500">{title}</p>
          {change != null && !loading && <ChangeBadge v={change} />}
        </div>
      </div>
      {/* Bottom row: value | sparkline */}
      <div className="mt-2 flex items-end justify-between gap-2">
        <div className="min-w-0">
          {loading
            ? <div className="h-6 w-28 animate-pulse rounded-lg bg-gray-100" />
            : <p className="text-lg font-extrabold tracking-tight text-gray-900">{value}</p>
          }
          {!loading && subtitle && (
            <p className="mt-0.5 text-[11px] text-gray-400">{subtitle}</p>
          )}
        </div>
        {spark && !loading && <div className="shrink-0 opacity-90">{spark}</div>}
      </div>
    </div>
  )
}

function ChangeBadge({ v }: { v: number | null | undefined }) {
  if (v == null) return null
  const up = v >= 0
  return (
    <span className={`inline-flex shrink-0 items-center gap-0.5 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
      up ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-500'
    }`}>
      {up ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
      {up ? '+' : ''}{Math.abs(v).toFixed(1)}%
    </span>
  )
}

function InventoryStatusRow({ iconEl, iconBg, label, desc, count, href }: {
  iconEl: React.ReactNode; iconBg: string; label: string; desc: string; count: number; href: string
}) {
  return (
    <Link href={href} className="flex flex-1 items-center gap-2.5 rounded-xl px-2.5 py-2 transition-colors hover:bg-gray-50">
      <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${iconBg}`}>
        {iconEl}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold text-gray-800">{label}</p>
        <p className="text-[11px] text-gray-400">{desc}</p>
      </div>
      <span className="text-sm font-bold text-gray-800">{count}</span>
      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-gray-300" />
    </Link>
  )
}

function QuickAction({ href, icon, label, desc, iconBg, iconColor, hoverBg }: {
  href: string; icon: React.ReactNode; label: string; desc: string
  iconBg: string; iconColor: string; hoverBg: string
}) {
  return (
    <Link href={href}
      className={`flex items-center gap-2.5 rounded-xl border border-gray-100 p-2.5 transition-colors ${hoverBg} group`}>
      <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${iconBg} ${iconColor}`}>
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-xs font-semibold text-gray-800 group-hover:text-gray-900">{label}</p>
        <p className="text-[10px] text-gray-400">{desc}</p>
      </div>
    </Link>
  )
}

function PulseRows({ n }: { n: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <div className="h-9 w-9 animate-pulse rounded-full bg-gray-100 shrink-0" />
          <div className="flex-1 space-y-1.5">
            <div className="h-3 w-3/4 animate-pulse rounded bg-gray-100" />
            <div className="h-2.5 w-1/2 animate-pulse rounded bg-gray-100" />
          </div>
          <div className="h-4 w-16 animate-pulse rounded bg-gray-100 shrink-0" />
        </div>
      ))}
    </div>
  )
}
