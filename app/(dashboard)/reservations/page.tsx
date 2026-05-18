'use client'

import React, { useDeferredValue, useEffect, useMemo, useState } from 'react'
import { collection, onSnapshot, orderBy, query } from 'firebase/firestore'
import {
  AlertCircle,
  Calendar,
  CheckCircle2,
  Clock,
  FileText,
  ReceiptText,
  RefreshCw,
  TrendingUp,
  XCircle,
} from 'lucide-react'
import { toast } from 'sonner'
import ProtectedRoute from '@/components/shared/ProtectedRoute'
import { CancellationReasonModal } from '@/components/reservations/CancellationReasonModal'
import { auth, db } from '@/lib/firebase'
import { toDate, toNumber } from '@/lib/server/salesInventoryMetrics'
import { getCancellationReasonTypeLabel, type CancellationReasonOption } from '@/lib/reservations/cancellationReasons'
import { expireReservations } from '@/lib/reservations/reservationExpiration'

type ReservationStatus = 'Active' | 'Completed' | 'Cancelled' | 'Expired'
type TabId = 'all' | ReservationStatus

interface ReservationItem {
  id: string
  name: string
  quantity: number
  price: number
  categoryName: string
  condition: string
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
  cancellationReason?: string
  cancellationReasonType?: 'manual' | 'system'
  cancelledBy?: string
  cancelledAt?: Date | null
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const fmtDate = (d: Date | null) => {
  if (!d) return '—'
  return d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })
}

const fmtTime = (d: Date | null) => {
  if (!d) return ''
  return d.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' })
}

const fmtDateTime = (d: Date | null) => {
  if (!d) return '—'
  return d.toLocaleString('en-PH', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

const msUntil = (d: Date | null) => {
  if (!d) return Infinity
  return d.getTime() - Date.now()
}

const fmtCountdown = (ms: number) => {
  if (ms <= 0) return 'Expired'
  const h = Math.floor(ms / 3_600_000)
  const d = Math.floor(h / 24)
  if (d > 0) return 'Expires in ' + d + ' day' + (d === 1 ? '' : 's')
  if (h > 0) return 'Expires in ' + h + 'h'
  return 'Expires soon'
}

// ── Badge Components ───────────────────────────────────────────────────────────

function ConditionBadge({ condition }: { condition: string }) {
  const map: Record<string, string> = {
    New: 'bg-blue-50 text-blue-700 ring-blue-200',
    Refurbished: 'bg-slate-100 text-slate-600 ring-slate-200',
    Good: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
    'Like New': 'bg-violet-50 text-violet-700 ring-violet-200',
  }
  return (
    <span className={'inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold ring-1 ring-inset ' + (map[condition] ?? 'bg-slate-100 text-slate-600 ring-slate-200')}>
      {condition}
    </span>
  )
}

function StatusBadge({ status }: { status: ReservationStatus }) {
  const map: Record<ReservationStatus, string> = {
    Active: 'bg-amber-50 text-amber-700 ring-amber-200',
    Completed: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
    Expired: 'bg-slate-100 text-slate-600 ring-slate-200',
    Cancelled: 'bg-rose-50 text-rose-700 ring-rose-200',
  }
  return (
    <span className={'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ' + map[status]}>
      {status}
    </span>
  )
}

// ── Pagination ─────────────────────────────────────────────────────────────────

function Pagination({
  total, page, perPage, onPage, onPerPage,
}: {
  total: number
  page: number
  perPage: number
  onPage: (p: number) => void
  onPerPage: (n: number) => void
}) {
  const pages = Math.max(1, Math.ceil(total / perPage))
  const from = total === 0 ? 0 : Math.min(total, (page - 1) * perPage + 1)
  const to = Math.min(total, page * perPage)
  const nums: (number | '...')[] = []
  if (pages <= 7) {
    for (let i = 1; i <= pages; i++) nums.push(i)
  } else {
    nums.push(1)
    if (page > 3) nums.push('...')
    for (let i = Math.max(2, page - 1); i <= Math.min(pages - 1, page + 1); i++) nums.push(i)
    if (page < pages - 2) nums.push('...')
    nums.push(pages)
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-4 py-3 text-sm">
      <span className="text-slate-500 text-xs">
        Showing {from}–{to} of{' '}
        <span className="font-semibold text-slate-700">{total}</span> reservations
      </span>
      <div className="flex items-center gap-1.5">
        <span className="mr-1 text-xs text-slate-400">Rows per page</span>
        <select
          value={perPage}
          onChange={(e) => { onPerPage(Number(e.target.value)); onPage(1) }}
          className="rounded border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700"
        >
          {[10, 25, 50].map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
        <button
          onClick={() => onPage(Math.max(1, page - 1))}
          disabled={page === 1}
          className="rounded border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-40"
        >
          ‹
        </button>
        {nums.map((n, i) =>
          n === '...' ? (
            <span key={'e' + i} className="px-1 text-xs text-slate-400">…</span>
          ) : (
            <button
              key={n}
              onClick={() => onPage(n as number)}
              className={
                'rounded border px-2.5 py-1 text-xs ' +
                (page === n
                  ? 'border-blue-500 bg-blue-500 text-white'
                  : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50')
              }
            >
              {n}
            </button>
          )
        )}
        <button
          onClick={() => onPage(Math.min(pages, page + 1))}
          disabled={page === pages}
          className="rounded border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-40"
        >
          ›
        </button>
      </div>
    </div>
  )
}

// ── Page Export ────────────────────────────────────────────────────────────────

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
  const [activeTab, setActiveTab] = useState<TabId>('Active')
  const [page, setPage] = useState(1)
  const [perPage, setPerPage] = useState(10)
  const [now, setNow] = useState(() => new Date())
  const [inventoryCategoryById, setInventoryCategoryById] = useState<Record<string, string>>({})
  const deferredSearch = useDeferredValue(search)

  const [cancellationModalOpen, setCancellationModalOpen] = useState(false)
  const [reservationToCancel, setReservationToCancel] = useState<Reservation | null>(null)
  const [viewReasonRes, setViewReasonRes] = useState<Reservation | null>(null)

  // Live clock (updates every 30s)
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    expireReservations().catch((e) => console.error('Error expiring reservations:', e))

    const unsubInv = onSnapshot(
      collection(db, 'inventory'),
      (snap) => {
        const map = snap.docs.reduce<Record<string, string>>((acc, d) => {
          const data = d.data() as Record<string, unknown>
          const cat =
            (typeof data.categoryName === 'string' && data.categoryName.trim()) ||
            (typeof data.category === 'string' && data.category.trim()) ||
            ''
          if (cat) acc[d.id] = cat
          return acc
        }, {})
        setInventoryCategoryById(map)
      },
      (e) => console.error('Error loading inventory categories:', e)
    )

    const resQuery = query(collection(db, 'reservations'), orderBy('createdAt', 'desc'))
    const unsubRes = onSnapshot(
      resQuery,
      (snap) => {
        const records = snap.docs.map((d) => {
          const data = d.data() as Record<string, unknown>
          const items = Array.isArray(data.items)
            ? data.items
                .map((item) => {
                  const ri = item as Record<string, unknown>
                  const name = typeof ri.name === 'string' ? ri.name.trim() : ''
                  const id = typeof ri.id === 'string' ? ri.id : ''
                  if (!id || !name) return null
                  return {
                    id,
                    name,
                    quantity: Math.max(0, toNumber(ri.quantity, 0)),
                    price: Math.max(0, toNumber(ri.price, 0)),
                    categoryName: '',
                    condition: typeof ri.condition === 'string' ? ri.condition : 'New',
                  } satisfies ReservationItem
                })
                .filter((x): x is ReservationItem => x !== null && x.quantity > 0)
            : []

          return {
            id: d.id,
            reservationNumber:
              typeof data.reservationNumber === 'string' && data.reservationNumber.trim()
                ? data.reservationNumber.trim()
                : d.id,
            items,
            customer:
              (typeof data.customer === 'string' && data.customer.trim()) ||
              (typeof data.customerName === 'string' && data.customerName.trim()) ||
              'Walk-in Customer',
            customerEmail: typeof data.customerEmail === 'string' ? data.customerEmail.trim() : '',
            customerContactNumber:
              typeof data.customerContactNumber === 'string' ? data.customerContactNumber.trim() : '',
            createdAt: toDate(data.createdAt ?? data.reservationDate),
            expiresAt: toDate(data.expiresAt),
            status:
              data.status === 'Active' ||
              data.status === 'Completed' ||
              data.status === 'Cancelled' ||
              data.status === 'Expired'
                ? data.status
                : 'Active',
            cancellationReason:
              typeof data.cancellationReason === 'string' ? data.cancellationReason : undefined,
            cancellationReasonType:
              data.cancellationReasonType === 'manual' || data.cancellationReasonType === 'system'
                ? data.cancellationReasonType
                : undefined,
            cancelledBy: typeof data.cancelledByName === 'string' ? data.cancelledByName : undefined,
            cancelledAt: toDate(data.cancelledAt),
          } satisfies Reservation
        })
        setReservations(records)
        setLoading(false)
      },
      (e) => {
        console.error('Error loading reservations:', e)
        setPageError('Failed to load reservations.')
        setLoading(false)
      }
    )

    return () => {
      unsubInv()
      unsubRes()
    }
  }, [])

  // ── Derived data ───────────────────────────────────────────────────────────────

  const counts = useMemo(
    () => ({
      Active: reservations.filter((r) => r.status === 'Active').length,
      Completed: reservations.filter((r) => r.status === 'Completed').length,
      Expired: reservations.filter((r) => r.status === 'Expired').length,
      Cancelled: reservations.filter((r) => r.status === 'Cancelled').length,
    }),
    [reservations]
  )

  const searchableReservations = useMemo(
    () =>
      reservations.map((res) => {
        const catNames = Array.from(
          new Set(
            res.items
              .map((i) => inventoryCategoryById[i.id] || i.categoryName)
              .map((n) => n.trim())
              .filter(Boolean)
          )
        )
        return {
          reservation: res,
          categoryNames: catNames,
          searchIndex: [
            res.reservationNumber,
            res.customer,
            res.customerEmail,
            ...res.items.map((i) => i.name),
            ...res.items.map((i) => i.condition),
            ...catNames,
          ]
            .join(' ')
            .toLowerCase(),
        }
      }),
    [reservations, inventoryCategoryById]
  )

  const categoryOptions = useMemo(() => {
    const set = new Set<string>()
    searchableReservations.forEach(({ categoryNames }) => categoryNames.forEach((n) => set.add(n)))
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [searchableReservations])

  const filteredReservations = useMemo(() => {
    const term = deferredSearch.trim().toLowerCase()
    const startTime = startDate ? new Date(startDate).getTime() : null
    const endTime = endDate ? new Date(new Date(endDate).setHours(23, 59, 59, 999)).getTime() : null

    return searchableReservations
      .filter(({ reservation: r, categoryNames, searchIndex }) => {
        if (activeTab !== 'all' && r.status !== activeTab) return false
        if (term && !searchIndex.includes(term)) return false
        if (statusFilter !== 'all' && r.status !== statusFilter) return false
        if (categoryFilter !== 'all' && !categoryNames.includes(categoryFilter)) return false
        const ct = r.createdAt?.getTime()
        if (ct != null) {
          if (startTime != null && ct < startTime) return false
          if (endTime != null && ct > endTime) return false
        }
        return true
      })
      .map(({ reservation }) => reservation)
  }, [searchableReservations, deferredSearch, statusFilter, categoryFilter, startDate, endDate, activeTab])

  const paginatedReservations = useMemo(() => {
    const start = (page - 1) * perPage
    return filteredReservations.slice(start, start + perPage)
  }, [filteredReservations, page, perPage])

  // Sidebar data
  const upcomingExpirations = useMemo(
    () =>
      reservations
        .filter((r) => r.status === 'Active' && r.expiresAt)
        .sort((a, b) => (a.expiresAt?.getTime() ?? 0) - (b.expiresAt?.getTime() ?? 0))
        .slice(0, 4),
    [reservations]
  )

  const recentlyCompleted = useMemo(
    () => reservations.filter((r) => r.status === 'Completed').slice(0, 4),
    [reservations]
  )

  const topCategory = useMemo(() => {
    const catMap: Record<string, number> = {}
    reservations.forEach((r) => {
      r.items.forEach((item) => {
        const cat = inventoryCategoryById[item.id] || item.categoryName || 'Uncategorized'
        catMap[cat] = (catMap[cat] ?? 0) + 1
      })
    })
    const sorted = Object.entries(catMap).sort((a, b) => b[1] - a[1])
    return sorted[0] ?? null
  }, [reservations, inventoryCategoryById])

  // ── Handlers ───────────────────────────────────────────────────────────────────

  const handleCompleteReservation = async (reservation: Reservation) => {
    if (reservation.status !== 'Active') return
    if (!window.confirm('Complete reservation for ' + reservation.customer + '?')) return
    setActionId(reservation.id)
    try {
      const res = await fetch('/api/reservations/' + reservation.id, {
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
      const payload = (await res.json()) as { error?: string }
      if (!res.ok) throw new Error(payload.error || 'Failed to complete reservation.')
      toast.success('Reservation completed successfully.')
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to complete reservation.'
      setPageError(msg)
      toast.error(msg)
    } finally {
      setActionId(null)
    }
  }

  const handleCancelReservation = (reservation: Reservation) => {
    if (reservation.status !== 'Active') return
    setReservationToCancel(reservation)
    setCancellationModalOpen(true)
  }

  const handleConfirmCancellation = async (reason: CancellationReasonOption, customReason?: string) => {
    if (!reservationToCancel) return
    setActionId(reservationToCancel.id)
    try {
      const res = await fetch('/api/reservations/' + reservationToCancel.id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'cancel',
          cancellationReason: reason,
          cancellationReasonType: 'manual',
          customCancellationReason: customReason,
          processedBy: {
            uid: auth.currentUser?.uid ?? '',
            email: auth.currentUser?.email ?? '',
            name: auth.currentUser?.displayName ?? auth.currentUser?.email ?? '',
          },
        }),
      })
      const payload = (await res.json()) as { error?: string }
      if (!res.ok) throw new Error(payload.error || 'Failed to cancel reservation.')
      toast.success('Reservation cancelled and reserved stock released.')
      setCancellationModalOpen(false)
      setReservationToCancel(null)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to cancel reservation.'
      setPageError(msg)
      toast.error(msg)
    } finally {
      setActionId(null)
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────────

  const TABS: { id: TabId; label: string; count?: number }[] = [
    { id: 'Active', label: 'Active', count: counts.Active },
    { id: 'Completed', label: 'Completed', count: counts.Completed },
    { id: 'Cancelled', label: 'Cancelled', count: counts.Cancelled },
    { id: 'all', label: 'All' },
  ]

  const hasFilters = search || statusFilter !== 'all' || categoryFilter !== 'all' || startDate || endDate

  return (
    <main className="min-h-[calc(100vh-64px)] bg-slate-50 px-3 py-4">
      <div className="mx-auto max-w-[1680px] space-y-4">

        {/* ── HEADER ── */}
        <header className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">Reservations</h1>
            <p className="mt-0.5 text-sm text-slate-500">
              Track active, completed, expired, and cancelled reservation records.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-500 shadow-sm">
              <Clock className="h-3.5 w-3.5 text-slate-400" />
              <span>
                {now.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })}
                {' · '}
                {now.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
            <button
              onClick={() => setNow(new Date())}
              title="Refresh"
              className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-600 shadow-sm transition-colors hover:bg-slate-50"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
            <div className="flex items-center gap-1.5 rounded-full bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-700 ring-1 ring-inset ring-amber-200">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
              Active Reservations: {counts.Active}
            </div>
          </div>
        </header>

        {/* ── KPI CARDS ── */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {([
            {
              label: 'ACTIVE RESERVATIONS',
              value: counts.Active,
              sub: 'Currently active',
              Icon: Calendar,
              iconBg: 'bg-amber-100',
              iconColor: 'text-amber-600',
              subColor: 'text-amber-500',
            },
            {
              label: 'COMPLETED RESERVATIONS',
              value: counts.Completed,
              sub: 'Successfully completed',
              Icon: CheckCircle2,
              iconBg: 'bg-emerald-100',
              iconColor: 'text-emerald-600',
              subColor: 'text-emerald-500',
            },
            {
              label: 'EXPIRED RESERVATIONS',
              value: counts.Expired,
              sub: 'Past expiration',
              Icon: Clock,
              iconBg: 'bg-slate-100',
              iconColor: 'text-slate-500',
              subColor: 'text-slate-400',
            },
            {
              label: 'CANCELLED RESERVATIONS',
              value: counts.Cancelled,
              sub: 'Manually cancelled',
              Icon: XCircle,
              iconBg: 'bg-rose-100',
              iconColor: 'text-rose-500',
              subColor: 'text-rose-500',
            },
          ] as const).map(({ label, value, sub, Icon, iconBg, iconColor, subColor }) => (
            <div
              key={label}
              className="flex items-center gap-3.5 rounded-xl border border-slate-200 bg-white px-4 py-4 shadow-sm transition-shadow hover:shadow-md"
            >
              <div className={'flex h-11 w-11 shrink-0 items-center justify-center rounded-full ' + iconBg}>
                <Icon className={'h-5 w-5 ' + iconColor} />
              </div>
              <div className="min-w-0">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
                <p className="text-2xl font-bold leading-tight text-slate-900">{value}</p>
                <p className={'text-xs ' + subColor}>{sub}</p>
              </div>
            </div>
          ))}
        </div>

        {/* ── MAIN + SIDEBAR ── */}
        <div className="flex gap-4">

          {/* ── MAIN PANEL ── */}
          <div className="flex min-w-0 flex-1 flex-col gap-0 rounded-xl border border-slate-200 bg-white shadow-sm">

            {/* Filter bar */}
            <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-3">
              {/* Search */}
              <div className="relative min-w-[200px] flex-1">
                <svg
                  className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400"
                  fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"
                >
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-4.35-4.35" />
                </svg>
                <input
                  type="text"
                  value={search}
                  onChange={(e) => { setSearch(e.target.value); setPage(1) }}
                  placeholder="Search reservation no., customer, email, or item..."
                  className="w-full rounded-lg border border-slate-200 py-2 pl-8 pr-3 text-xs text-slate-900 outline-none transition focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
                />
              </div>

              {/* Status */}
              <select
                value={statusFilter}
                onChange={(e) => { setStatusFilter(e.target.value as 'all' | ReservationStatus); setPage(1) }}
                className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 outline-none focus:border-blue-400"
              >
                <option value="all">All Statuses</option>
                <option value="Active">Active</option>
                <option value="Completed">Completed</option>
                <option value="Cancelled">Cancelled</option>
                <option value="Expired">Expired</option>
              </select>

              {/* Category */}
              <select
                value={categoryFilter}
                onChange={(e) => { setCategoryFilter(e.target.value); setPage(1) }}
                className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 outline-none focus:border-blue-400"
              >
                <option value="all">All Categories</option>
                {categoryOptions.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>

              {/* Date range */}
              <div className="flex items-center gap-1.5">
                <input
                  type="date"
                  value={startDate}
                  max={endDate || undefined}
                  onChange={(e) => { setStartDate(e.target.value); setPage(1) }}
                  className="rounded-lg border border-slate-200 px-2 py-2 text-xs text-slate-700 outline-none focus:border-blue-400"
                />
                <span className="text-xs text-slate-300">–</span>
                <input
                  type="date"
                  value={endDate}
                  min={startDate || undefined}
                  onChange={(e) => { setEndDate(e.target.value); setPage(1) }}
                  className="rounded-lg border border-slate-200 px-2 py-2 text-xs text-slate-700 outline-none focus:border-blue-400"
                />
              </div>

              {/* Reset */}
              {hasFilters ? (
                <button
                  onClick={() => {
                    setSearch('')
                    setStatusFilter('all')
                    setCategoryFilter('all')
                    setStartDate('')
                    setEndDate('')
                    setPage(1)
                  }}
                  className="flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 transition-colors hover:bg-slate-100"
                >
                  <RefreshCw className="h-3 w-3" /> Reset Filters
                </button>
              ) : null}
            </div>

            {/* Tab bar */}
            <div className="flex gap-0 overflow-x-auto border-b border-slate-100 px-4 pt-1">
              {TABS.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => { setActiveTab(tab.id); setPage(1) }}
                  className={
                    'flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2.5 text-xs font-medium transition-colors ' +
                    (activeTab === tab.id
                      ? 'border-blue-500 text-blue-600'
                      : 'border-transparent text-slate-500 hover:text-slate-700')
                  }
                >
                  {tab.label}
                  {tab.count != null && tab.count > 0 ? (
                    <span
                      className={
                        'rounded-full px-1.5 py-0.5 text-[10px] font-bold ' +
                        (activeTab === tab.id ? 'bg-blue-100 text-blue-600' : 'bg-slate-100 text-slate-500')
                      }
                    >
                      {tab.count}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>

            {pageError ? (
              <div className="mx-4 mt-3 flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
                <AlertCircle className="h-4 w-4 shrink-0" />
                {pageError}
              </div>
            ) : null}

            {/* Table */}
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-100 bg-slate-50/70 text-left">
                    {[
                      'Reservation No.',
                      'Item',
                      'Customer',
                      'Qty',
                      'Reservation Date',
                      'Expiration',
                      'Status',
                      ...(activeTab !== 'Active' ? ['Cancellation Info'] : []),
                      'Actions',
                    ].map((col) => (
                      <th
                        key={col}
                        className={
                          'px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500 ' +
                          (col === 'Qty' ? 'text-center' : '')
                        }
                      >
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {loading ? (
                    <tr>
                      <td colSpan={9} className="py-12 text-center text-sm text-slate-400">
                        Loading reservations…
                      </td>
                    </tr>
                  ) : paginatedReservations.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="py-12 text-center text-sm text-slate-400">
                        No reservations found.
                      </td>
                    </tr>
                  ) : (
                    paginatedReservations.map((r) => {
                      const isExpiringSoon =
                        r.status === 'Active' && r.expiresAt && msUntil(r.expiresAt) < 86_400_000
                      const totalQty = r.items.reduce((s, i) => s + i.quantity, 0)

                      return (
                        <tr key={r.id} className="group transition-colors hover:bg-blue-50/30">
                          {/* Reservation No. */}
                          <td className="whitespace-nowrap px-4 py-3">
                            <span className="font-mono text-xs font-semibold text-slate-700">
                              {r.reservationNumber}
                            </span>
                          </td>

                          {/* Item */}
                          <td className="max-w-[180px] px-4 py-3">
                            {r.items.length > 0 ? (
                              <div className="space-y-1.5">
                                {r.items.map((item) => (
                                  <div key={item.id}>
                                    <p className="text-xs font-semibold leading-snug text-slate-800">
                                      {item.name}
                                    </p>
                                    <ConditionBadge condition={item.condition} />
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <span className="text-xs text-slate-400">No items</span>
                            )}
                          </td>

                          {/* Customer */}
                          <td className="px-4 py-3">
                            <p className="text-xs font-semibold text-slate-800">{r.customer}</p>
                            {r.customerContactNumber ? (
                              <p className="mt-0.5 text-[11px] text-slate-500">{r.customerContactNumber}</p>
                            ) : null}
                            {r.customerEmail ? (
                              <p className="max-w-[160px] truncate text-[11px] text-slate-400">
                                {r.customerEmail}
                              </p>
                            ) : null}
                          </td>

                          {/* Qty */}
                          <td className="px-4 py-3 text-center text-sm font-semibold text-slate-700">
                            {totalQty}
                          </td>

                          {/* Reservation Date */}
                          <td className="whitespace-nowrap px-4 py-3">
                            <p className="text-xs font-medium text-slate-700">{fmtDate(r.createdAt)}</p>
                            <p className="text-[11px] text-slate-400">{fmtTime(r.createdAt)}</p>
                          </td>

                          {/* Expiration */}
                          <td className="whitespace-nowrap px-4 py-3">
                            <p
                              className={
                                'text-xs font-medium ' +
                                (isExpiringSoon ? 'text-rose-600' : 'text-slate-700')
                              }
                            >
                              {fmtDate(r.expiresAt)}
                            </p>
                            <p
                              className={
                                'text-[11px] ' +
                                (isExpiringSoon ? 'text-rose-400' : 'text-slate-400')
                              }
                            >
                              {fmtTime(r.expiresAt)}
                            </p>
                          </td>

                          {/* Status */}
                          <td className="px-4 py-3">
                            <StatusBadge status={r.status} />
                          </td>

                          {/* Cancellation Info */}
                          {activeTab !== 'Active' && (
                          <td className="max-w-[170px] px-4 py-3">
                            {r.status === 'Cancelled' && r.cancellationReason ? (
                              <div className="rounded-lg border border-rose-100 bg-rose-50 px-2.5 py-2 text-[11px] space-y-0.5">
                                <p className="font-semibold text-rose-700">{r.cancellationReason}</p>
                                <p className="text-rose-500">
                                  {r.cancellationReasonType
                                    ? getCancellationReasonTypeLabel(r.cancellationReasonType)
                                    : 'Unknown'}
                                </p>
                                {r.cancelledBy ? (
                                  <p className="text-slate-500">By: {r.cancelledBy}</p>
                                ) : null}
                                {r.cancelledAt ? (
                                  <p className="text-slate-400">
                                    {fmtDate(r.cancelledAt)}, {fmtTime(r.cancelledAt)}
                                  </p>
                                ) : null}
                              </div>
                            ) : (
                              <span className="text-slate-300">—</span>
                            )}
                          </td>
                          )}

                          {/* Actions */}
                          <td className="px-4 py-3">
                            {r.status === 'Active' ? (
                              <div className="flex items-center gap-1.5">
                                <button
                                  disabled={actionId === r.id}
                                  onClick={() => handleCompleteReservation(r)}
                                  title="Complete Sale"
                                  className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500 text-white shadow-sm transition-colors hover:bg-emerald-600 disabled:opacity-50"
                                >
                                  <CheckCircle2 className="h-4 w-4" />
                                </button>
                                <button
                                  disabled={actionId === r.id}
                                  onClick={() => handleCancelReservation(r)}
                                  title="Cancel Reservation"
                                  className="flex h-8 w-8 items-center justify-center rounded-lg border border-rose-200 bg-rose-50 text-rose-500 transition-colors hover:bg-rose-100 disabled:opacity-50"
                                >
                                  <XCircle className="h-4 w-4" />
                                </button>
                              </div>
                            ) : r.status === 'Completed' ? (
                              <button
                                title="View Receipt"
                                className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-slate-500 transition-colors hover:bg-slate-100"
                              >
                                <ReceiptText className="h-4 w-4" />
                              </button>
                            ) : r.status === 'Expired' ? (
                              <button
                                title="View Log"
                                className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-slate-500 transition-colors hover:bg-slate-100"
                              >
                                <FileText className="h-4 w-4" />
                              </button>
                            ) : r.status === 'Cancelled' ? (
                              <button
                                onClick={() => setViewReasonRes(r)}
                                title="View Reason"
                                className="flex h-8 w-8 items-center justify-center rounded-lg border border-rose-200 bg-rose-50 text-rose-500 transition-colors hover:bg-rose-100"
                              >
                                <AlertCircle className="h-4 w-4" />
                              </button>
                            ) : null}
                          </td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            <Pagination
              total={filteredReservations.length}
              page={page}
              perPage={perPage}
              onPage={setPage}
              onPerPage={(n) => { setPerPage(n); setPage(1) }}
            />
          </div>

          {/* ── RIGHT SIDEBAR ── */}
          <div className="hidden w-[272px] shrink-0 flex-col gap-3 lg:flex">

            {/* Widget 1 – Upcoming Expirations */}
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="mb-3 flex items-center gap-2">
                <Clock className="h-4 w-4 text-amber-500" />
                <h3 className="text-xs font-semibold text-slate-800">Upcoming Expirations</h3>
              </div>
              {upcomingExpirations.length === 0 ? (
                <p className="text-xs text-slate-400">No upcoming expirations.</p>
              ) : (
                <div className="space-y-2.5">
                  {upcomingExpirations.map((r) => {
                    const ms = msUntil(r.expiresAt)
                    const urgent = ms < 86_400_000
                    return (
                      <div key={r.id} className="flex items-start gap-2.5">
                        <div
                          className={
                            'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full ' +
                            (urgent ? 'bg-rose-100' : 'bg-amber-100')
                          }
                        >
                          <Clock className={'h-2.5 w-2.5 ' + (urgent ? 'text-rose-500' : 'text-amber-500')} />
                        </div>
                        <div className="min-w-0">
                          <p className="truncate text-[11px] font-semibold text-slate-700">
                            {r.items[0]?.name ?? 'Item'}
                          </p>
                          <p className="font-mono text-[10px] text-slate-400">{r.reservationNumber}</p>
                          <p className={'text-[10px] font-medium ' + (urgent ? 'text-rose-500' : 'text-amber-500')}>
                            {fmtCountdown(ms)}
                          </p>
                        </div>
                      </div>
                    )
                  })}
                  <button
                    onClick={() => { setActiveTab('Active'); setPage(1) }}
                    className="mt-0.5 text-[11px] font-medium text-blue-500 transition-colors hover:text-blue-700"
                  >
                    View all upcoming →
                  </button>
                </div>
              )}
            </div>

            {/* Widget 2 – Recently Completed */}
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="mb-3 flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                <h3 className="text-xs font-semibold text-slate-800">Recently Completed</h3>
              </div>
              {recentlyCompleted.length === 0 ? (
                <p className="text-xs text-slate-400">No completed reservations yet.</p>
              ) : (
                <div className="space-y-2.5">
                  {recentlyCompleted.map((r) => (
                    <div key={r.id} className="flex items-start gap-2.5">
                      <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-100">
                        <CheckCircle2 className="h-2.5 w-2.5 text-emerald-500" />
                      </div>
                      <div className="min-w-0">
                        <p className="truncate text-[11px] font-semibold text-slate-700">
                          {r.items[0]?.name ?? 'Item'}
                        </p>
                        <p className="font-mono text-[10px] text-slate-400">{r.reservationNumber}</p>
                        <p className="text-[10px] text-slate-400">
                          {fmtDate(r.createdAt)}, {fmtTime(r.createdAt)}
                        </p>
                      </div>
                    </div>
                  ))}
                  <button
                    onClick={() => { setActiveTab('Completed'); setPage(1) }}
                    className="mt-0.5 text-[11px] font-medium text-blue-500 transition-colors hover:text-blue-700"
                  >
                    View all completed →
                  </button>
                </div>
              )}
            </div>

            {/* Widget 3 – Reservation Insights */}
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="mb-3 flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-blue-500" />
                <h3 className="text-xs font-semibold text-slate-800">Reservation Insights</h3>
              </div>
              {topCategory ? (
                <>
                  <p className="text-xs leading-relaxed text-slate-600">
                    <span className="font-semibold text-blue-600">{topCategory[0]}</span> currently have
                    the highest reservation volume this month.
                  </p>
                  <div className="mt-3 overflow-hidden rounded-lg">
                    <svg
                      viewBox="0 0 200 52"
                      className="w-full"
                      fill="none"
                      xmlns="http://www.w3.org/2000/svg"
                    >
                      <defs>
                        <linearGradient id="insightGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.18" />
                          <stop offset="100%" stopColor="#3b82f6" stopOpacity="0" />
                        </linearGradient>
                      </defs>
                      <polyline
                        points="0,42 28,36 55,28 80,32 108,20 135,24 162,13 200,16"
                        stroke="#3b82f6"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        fill="none"
                        opacity="0.85"
                      />
                      <polygon
                        points="0,42 28,36 55,28 80,32 108,20 135,24 162,13 200,16 200,52 0,52"
                        fill="url(#insightGrad)"
                      />
                    </svg>
                  </div>
                  <button
                    onClick={() => { window.location.href = '/analytics' }}
                    className="mt-2 text-[11px] font-medium text-blue-500 transition-colors hover:text-blue-700"
                  >
                    View full analytics →
                  </button>
                </>
              ) : (
                <p className="text-xs text-slate-400">No reservation data available yet.</p>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── CANCELLATION MODAL ── */}
      {reservationToCancel ? (
        <CancellationReasonModal
          isOpen={cancellationModalOpen}
          customerName={reservationToCancel.customer}
          reservationNumber={reservationToCancel.reservationNumber}
          isLoading={actionId === reservationToCancel.id}
          onConfirm={handleConfirmCancellation}
          onCancel={() => {
            setCancellationModalOpen(false)
            setReservationToCancel(null)
          }}
        />
      ) : null}

      {/* ── VIEW REASON MODAL ── */}
      {viewReasonRes ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
          onClick={() => setViewReasonRes(null)}
        >
          <div
            className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-800">Cancellation Reason</h3>
              <button
                onClick={() => setViewReasonRes(null)}
                className="rounded-lg p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
              >
                <XCircle className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-2.5 rounded-xl border border-rose-100 bg-rose-50 px-4 py-3">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-rose-400">Reason</p>
                <p className="text-sm font-semibold text-rose-700">{viewReasonRes.cancellationReason || '—'}</p>
              </div>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-rose-400">Type</p>
                <p className="text-xs text-slate-600">
                  {viewReasonRes.cancellationReasonType
                    ? getCancellationReasonTypeLabel(viewReasonRes.cancellationReasonType)
                    : '—'}
                </p>
              </div>
              {viewReasonRes.cancelledBy ? (
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-rose-400">Cancelled By</p>
                  <p className="text-xs text-slate-600">{viewReasonRes.cancelledBy}</p>
                </div>
              ) : null}
              {viewReasonRes.cancelledAt ? (
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-rose-400">Date</p>
                  <p className="text-xs text-slate-600">{fmtDateTime(viewReasonRes.cancelledAt)}</p>
                </div>
              ) : null}
            </div>
            <button
              onClick={() => setViewReasonRes(null)}
              className="mt-4 w-full rounded-lg bg-slate-800 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-slate-900"
            >
              Close
            </button>
          </div>
        </div>
      ) : null}
    </main>
  )
}
