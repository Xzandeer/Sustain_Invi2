'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { collection, getDocs } from 'firebase/firestore'
import { toast } from 'sonner'
import ProtectedRoute from '@/components/shared/ProtectedRoute'
import { auth, db } from '@/lib/firebase'
import { normalizeInventoryCondition } from '@/lib/server/salesInventoryMetrics'
import { useUserRole } from '@/hooks/useUserRole'

// ── Types ──────────────────────────────────────────────────────────────────────
interface TrashItem {
  id: string
  name: string
  sku: string
  category: string
  condition: string
  stock: number
  reservedStock: number
  isDeleted: boolean
  isVoided: boolean
  deletedAt: string | null
  voidedAt: string | null
  voidedBy: string | null
  voidReason: string | null
  restoredAt: string | null
}

const VOID_REASONS = ['Damaged', 'Defective', 'Supplier Pullout', 'Duplicate Entry', 'Wrong Item Encoding', 'Discontinued', 'Other']

// ── Helpers ────────────────────────────────────────────────────────────────────
const toNumber = (v: unknown, fallback = 0) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') { const n = Number(v); if (Number.isFinite(n)) return n }
  return fallback
}

const formatDate = (v: string | null) => {
  if (!v) return '—'
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? v : d.toLocaleString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

const thisMonthStart = () => {
  const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d
}

// ── Badge components ───────────────────────────────────────────────────────────
function ConditionBadge({ condition }: { condition: string }) {
  const map: Record<string, string> = {
    New: 'bg-blue-50 text-blue-700 ring-blue-200',
    Refurbished: 'bg-slate-100 text-slate-600 ring-slate-200',
    Good: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
    'Like New': 'bg-violet-50 text-violet-700 ring-violet-200',
  }
  return (
    <span className={'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ' + (map[condition] ?? 'bg-slate-100 text-slate-600 ring-slate-200')}>
      {condition}
    </span>
  )
}

function ReasonBadge({ reason }: { reason: string | null }) {
  if (!reason) return <span className="text-slate-300 text-sm">—</span>
  const map: Record<string, string> = {
    Damaged: 'bg-red-50 text-red-700 ring-red-200',
    Defective: 'bg-red-50 text-red-600 ring-red-200',
    'Supplier Pullout': 'bg-amber-50 text-amber-700 ring-amber-200',
    'Duplicate Entry': 'bg-orange-50 text-orange-700 ring-orange-200',
    'Wrong Item Encoding': 'bg-yellow-50 text-yellow-700 ring-yellow-200',
    Discontinued: 'bg-pink-50 text-pink-700 ring-pink-200',
  }
  return (
    <span className={'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ' + (map[reason] ?? 'bg-slate-100 text-slate-600 ring-slate-200')}>
      {reason}
    </span>
  )
}

function StatusBadge({ stock, reserved }: { stock: number; reserved: number }) {
  if (reserved > 0) return (
    <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2.5 py-0.5 text-xs font-semibold text-red-700 ring-1 ring-inset ring-red-200">
      <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
      Has Reservation
    </span>
  )
  if (stock > 0) return (
    <span className="inline-flex items-center gap-1 rounded-full bg-orange-50 px-2.5 py-0.5 text-xs font-semibold text-orange-700 ring-1 ring-inset ring-orange-200">
      <span className="h-1.5 w-1.5 rounded-full bg-orange-400" />
      Has Stock
    </span>
  )
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-500 ring-1 ring-inset ring-slate-200">
      <span className="h-1.5 w-1.5 rounded-full bg-slate-400" />
      No Stock
    </span>
  )
}

// ── Pagination ─────────────────────────────────────────────────────────────────
function Pagination({ total, page, perPage, onPage, onPerPage }: { total: number; page: number; perPage: number; onPage: (p: number) => void; onPerPage: (n: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / perPage))
  const from = Math.min(total, (page - 1) * perPage + 1)
  const to = Math.min(total, page * perPage)
  const nums: (number | '...')[] = []
  if (pages <= 7) { for (let i = 1; i <= pages; i++) nums.push(i) }
  else {
    nums.push(1)
    if (page > 3) nums.push('...')
    for (let i = Math.max(2, page - 1); i <= Math.min(pages - 1, page + 1); i++) nums.push(i)
    if (page < pages - 2) nums.push('...')
    nums.push(pages)
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-4 py-3 text-sm">
      <span className="text-slate-500">Showing {from}–{to} of <span className="font-semibold text-slate-700">{total}</span> items</span>
      <div className="flex items-center gap-1.5">
        <select value={perPage} onChange={e => { onPerPage(Number(e.target.value)); onPage(1) }}
          className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-sm text-slate-700 focus:outline-none">
          {[10, 25, 50].map(n => <option key={n} value={n}>{n} per page</option>)}
        </select>
        <button onClick={() => onPage(page - 1)} disabled={page === 1}
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 hover:bg-slate-50 disabled:opacity-40">
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
        </button>
        {nums.map((p, i) => p === '...'
          ? <span key={'e' + i} className="flex h-8 w-8 items-center justify-center text-slate-400">…</span>
          : <button key={p} onClick={() => onPage(p as number)}
              className={'flex h-8 w-8 items-center justify-center rounded-lg border text-sm font-medium transition ' + (page === p ? 'border-[#1e3a5f] bg-[#1e3a5f] text-white' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50')}>
              {p}
            </button>
        )}
        <button onClick={() => onPage(page + 1)} disabled={page === pages}
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 hover:bg-slate-50 disabled:opacity-40">
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
        </button>
      </div>
    </div>
  )
}

// ── Main Page ──────────────────────────────────────────────────────────────────
export default function InventoryTrashPage() {
  return (
    <ProtectedRoute requireAdmin>
      <InventoryTrashContent />
    </ProtectedRoute>
  )
}

function InventoryTrashContent() {
  const { isAdmin } = useUserRole()
  const [items, setItems] = useState<TrashItem[]>([])
  const [loading, setLoading] = useState(true)
  const [actionId, setActionId] = useState<string | null>(null)
  const [error, setError] = useState('')

  // Filters
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [conditionFilter, setConditionFilter] = useState('all')
  const [reasonFilter, setReasonFilter] = useState('all')
  const [stockFilter, setStockFilter] = useState('all')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [currentPage, setCurrentPage] = useState(1)
  const [perPage, setPerPage] = useState(10)

  useEffect(() => {
    let cancelled = false
    async function loadTrash() {
      try {
        const snap = await getDocs(collection(db, 'inventory'))
        if (cancelled) return
        const rows: TrashItem[] = snap.docs.map((docItem) => {
          const data = docItem.data() as Record<string, unknown>
          return {
            id: docItem.id,
            name: typeof data.name === 'string' ? data.name.trim() : '',
            sku: typeof data.sku === 'string' ? data.sku.trim() : (typeof data.id === 'string' ? data.id.slice(0, 12).toUpperCase() : docItem.id.slice(0, 12).toUpperCase()),
            category: (typeof data.categoryName === 'string' && data.categoryName.trim()) || (typeof data.category === 'string' && data.category.trim()) || 'Uncategorized',
            condition: normalizeInventoryCondition(data.condition),
            stock: Math.max(0, toNumber(data.stock ?? data.quantity, 0)),
            reservedStock: Math.max(0, toNumber(data.reservedStock, 0)),
            isDeleted: data.isDeleted === true,
            isVoided: data.isVoided === true,
            deletedAt: typeof data.deletedAt === 'string' ? data.deletedAt : null,
            voidedAt: typeof data.voidedAt === 'string' ? data.voidedAt : null,
            voidedBy: typeof data.voidedBy === 'string' ? data.voidedBy : null,
            voidReason: typeof data.voidReason === 'string' ? data.voidReason : null,
            restoredAt: typeof data.restoredAt === 'string' ? data.restoredAt : null,
          }
        }).filter(item => item.name && (item.isDeleted || item.isVoided))
        rows.sort((a, b) => {
          const at = a.voidedAt ?? a.deletedAt ?? ''
          const bt = b.voidedAt ?? b.deletedAt ?? ''
          return bt.localeCompare(at)
        })
        setItems(rows)
        setLoading(false)
      } catch (err) {
        console.error(err)
        setError('Failed to load trash.')
        setLoading(false)
      }
    }
    loadTrash()
    return () => { cancelled = true }
  }, [])

  const categories = useMemo(() => Array.from(new Set(items.map(i => i.category))).sort(), [items])

  const summary = useMemo(() => {
    const monthStart = thisMonthStart()
    return {
      total: items.length,
      withStock: items.filter(i => i.stock > 0).length,
      withReservations: items.filter(i => i.reservedStock > 0).length,
      restoredThisMonth: items.filter(i => i.restoredAt && new Date(i.restoredAt) >= monthStart).length,
    }
  }, [items])

  const filteredItems = useMemo(() => {
    const term = search.trim().toLowerCase()
    const startTime = startDate ? new Date(startDate).getTime() : null
    const endTime = endDate ? new Date(new Date(endDate).setHours(23, 59, 59, 999)).getTime() : null

    return items.filter(item => {
      const dateStr = item.voidedAt ?? item.deletedAt
      const t = dateStr ? new Date(dateStr).getTime() : null

      const matchSearch = !term || item.name.toLowerCase().includes(term) || item.sku.toLowerCase().includes(term) || (item.voidReason ?? '').toLowerCase().includes(term)
      const matchCat = categoryFilter === 'all' || item.category === categoryFilter
      const matchCond = conditionFilter === 'all' || item.condition === conditionFilter
      const matchReason = reasonFilter === 'all' || item.voidReason === reasonFilter
      const matchDate = t == null ? true : (startTime == null || t >= startTime) && (endTime == null || t <= endTime)
      const matchStock =
        stockFilter === 'all' ? true :
        stockFilter === 'has_stock' ? item.stock > 0 :
        stockFilter === 'has_reservation' ? item.reservedStock > 0 :
        stockFilter === 'no_stock' ? item.stock === 0 && item.reservedStock === 0 : true

      return matchSearch && matchCat && matchCond && matchReason && matchDate && matchStock
    })
  }, [items, search, categoryFilter, conditionFilter, reasonFilter, startDate, endDate, stockFilter])

  const totalPages = Math.max(1, Math.ceil(filteredItems.length / perPage))
  const safePage = Math.min(currentPage, totalPages)
  const paginatedItems = filteredItems.slice((safePage - 1) * perPage, safePage * perPage)

  const handleAction = async (id: string, action: 'restore' | 'permanent-delete' | 'unvoid') => {
    if (!isAdmin) return
    setError('')
    setActionId(id)
    try {
      const response = await fetch('/api/inventory/' + id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          processedBy: {
            uid: auth.currentUser?.uid ?? '',
            email: auth.currentUser?.email ?? '',
            name: auth.currentUser?.displayName ?? auth.currentUser?.email ?? '',
          },
        }),
      })
      const payload = (await response.json()) as { error?: string }
      if (!response.ok) throw new Error(payload.error || 'Action failed.')
      toast.success('Item restored to inventory.')
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Action failed.'
      setError(msg)
      toast.error(msg)
    } finally {
      setActionId(null)
    }
  }

  const hasActiveFilters = search || categoryFilter !== 'all' || conditionFilter !== 'all' || reasonFilter !== 'all' || stockFilter !== 'all' || startDate || endDate
  const resetFilters = () => { setSearch(''); setCategoryFilter('all'); setConditionFilter('all'); setReasonFilter('all'); setStockFilter('all'); setStartDate(''); setEndDate(''); setCurrentPage(1) }

  return (
    <main className="min-h-[calc(100vh-64px)] bg-slate-50 px-3 py-3 sm:px-5 sm:py-4">
      <div className="mx-auto max-w-[1400px] space-y-3">

        {/* ── Header ── */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-red-50">
              <svg className="h-5 w-5 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </div>
            <div>
              <h1 className="text-lg font-bold text-slate-900 sm:text-xl">Inventory Trash</h1>
              <p className="text-xs text-slate-500">Manage voided or archived inventory items</p>
            </div>
          </div>
          <Link href="/inventory"
            className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
            Back to Inventory
          </Link>
        </div>

        {/* ── Summary Cards ── */}
        <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
          <div className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-100">
              <svg className="h-4.5 w-4.5 h-5 w-5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Total Items</p>
              <p className="text-2xl font-bold text-slate-900">{summary.total}</p>
            </div>
          </div>
          <div className="flex items-center gap-3 rounded-2xl border border-orange-100 bg-white p-4 shadow-sm">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-orange-50">
              <svg className="h-5 w-5 text-orange-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" /></svg>
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-orange-400">With Stock</p>
              <p className="text-2xl font-bold text-slate-900">{summary.withStock}</p>
            </div>
          </div>
          <div className="flex items-center gap-3 rounded-2xl border border-red-100 bg-white p-4 shadow-sm">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-red-50">
              <svg className="h-5 w-5 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-red-400">With Reservations</p>
              <p className="text-2xl font-bold text-slate-900">{summary.withReservations}</p>
            </div>
          </div>
          <div className="flex items-center gap-3 rounded-2xl border border-emerald-100 bg-white p-4 shadow-sm">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-50">
              <svg className="h-5 w-5 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-400">Restored This Month</p>
              <p className="text-2xl font-bold text-slate-900">{summary.restoredThisMonth}</p>
            </div>
          </div>
        </div>

        {/* ── Filter Bar ── */}
        <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-2.5 shadow-sm">
          <div className="flex min-w-[200px] flex-1 items-center gap-2 rounded-lg border border-slate-200 px-3 py-1.5">
            <svg className="h-4 w-4 shrink-0 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><circle cx="11" cy="11" r="8"/><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35"/></svg>
            <input type="text" value={search} onChange={e => { setSearch(e.target.value); setCurrentPage(1) }}
              placeholder="Search by item name, SKU, or reason..."
              className="w-full bg-transparent text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none" />
            {search && (
              <button onClick={() => setSearch('')} className="text-slate-300 hover:text-slate-500">
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            )}
          </div>
          <select value={categoryFilter} onChange={e => { setCategoryFilter(e.target.value); setCurrentPage(1) }}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 focus:outline-none">
            <option value="all">All Categories</option>
            {categories.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={conditionFilter} onChange={e => { setConditionFilter(e.target.value); setCurrentPage(1) }}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 focus:outline-none">
            <option value="all">All Conditions</option>
            <option value="New">New</option>
            <option value="Refurbished">Refurbished</option>
          </select>
          <select value={reasonFilter} onChange={e => { setReasonFilter(e.target.value); setCurrentPage(1) }}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 focus:outline-none">
            <option value="all">All Reasons</option>
            {VOID_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
          <select value={stockFilter} onChange={e => { setStockFilter(e.target.value); setCurrentPage(1) }}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 focus:outline-none">
            <option value="all">All Statuses</option>
            <option value="has_stock">Has Stock</option>
            <option value="has_reservation">Has Reservation</option>
            <option value="no_stock">No Stock</option>
          </select>
          <div className="flex items-center gap-1.5">
            <input type="date" value={startDate} max={endDate || undefined}
              onChange={e => { setStartDate(e.target.value); setCurrentPage(1) }}
              className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm text-slate-700 focus:outline-none" />
            <span className="text-slate-300">—</span>
            <input type="date" value={endDate} min={startDate || undefined}
              onChange={e => { setEndDate(e.target.value); setCurrentPage(1) }}
              className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm text-slate-700 focus:outline-none" />
          </div>
          {hasActiveFilters && (
            <button onClick={resetFilters}
              className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-600 transition hover:bg-slate-50">
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
              Reset
            </button>
          )}
        </div>

        {/* ── Main Table Card ── */}
        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
          {error && <p className="px-4 py-3 text-sm text-red-600">{error}</p>}

          {loading ? (
            <div className="flex items-center justify-center py-16">
              <svg className="h-6 w-6 animate-spin text-slate-400" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>
            </div>
          ) : filteredItems.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100">
                <svg className="h-7 w-7 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
              </div>
              <p className="text-sm font-semibold text-slate-700">No trashed items</p>
              <p className="mt-1 text-xs text-slate-400">Voided items will appear here</p>
              {hasActiveFilters && (
                <button onClick={resetFilters} className="mt-3 text-xs font-medium text-blue-600 hover:underline">Clear filters</button>
              )}
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[860px] text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 bg-slate-50 text-left">
                      <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-slate-400">Item</th>
                      <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-slate-400">Category</th>
                      <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-slate-400">Condition</th>
                      <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-slate-400">Date Voided</th>
                      <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-slate-400">Reason</th>
                      <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-slate-400">Voided By</th>
                      <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-slate-400">Status</th>
                      <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-slate-400">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {paginatedItems.map(item => {
                      const canRestore = item.stock === 0 && item.reservedStock === 0
                      const tooltipMsg = item.reservedStock > 0
                        ? 'Cannot restore while reservations exist'
                        : item.stock > 0
                        ? 'Cannot restore while stock exists'
                        : ''
                      return (
                        <tr key={item.id} className="transition-colors hover:bg-slate-50/70">
                          <td className="px-4 py-3 align-middle">
                            <p className="font-semibold text-slate-900">{item.name}</p>
                            <p className="mt-0.5 font-mono text-[11px] text-slate-400">{item.sku}</p>
                          </td>
                          <td className="px-4 py-3 align-middle text-sm text-slate-600">{item.category}</td>
                          <td className="px-4 py-3 align-middle"><ConditionBadge condition={item.condition} /></td>
                          <td className="whitespace-nowrap px-4 py-3 align-middle text-sm text-slate-600">{formatDate(item.voidedAt ?? item.deletedAt)}</td>
                          <td className="px-4 py-3 align-middle"><ReasonBadge reason={item.voidReason} /></td>
                          <td className="whitespace-nowrap px-4 py-3 align-middle text-sm text-slate-600">{item.voidedBy ?? '—'}</td>
                          <td className="px-4 py-3 align-middle"><StatusBadge stock={item.stock} reserved={item.reservedStock} /></td>
                          <td className="px-4 py-3 align-middle">
                            <div className="relative inline-block group">
                              <button
                                disabled={!isAdmin || actionId === item.id || !canRestore}
                                onClick={() => handleAction(item.id, item.isVoided ? 'unvoid' : 'restore')}
                                className={
                                  'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ' +
                                  (canRestore
                                    ? 'border border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 disabled:opacity-50'
                                    : 'cursor-not-allowed border border-slate-200 bg-slate-50 text-slate-400')
                                }
                              >
                                {actionId === item.id ? (
                                  <svg className="h-3.5 w-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>
                                ) : (
                                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                                )}
                                Restore
                              </button>
                              {!canRestore && tooltipMsg && (
                                <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 -translate-x-1/2 whitespace-nowrap rounded-lg bg-slate-800 px-2.5 py-1.5 text-[11px] text-white opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
                                  {tooltipMsg}
                                  <div className="absolute left-1/2 top-full -translate-x-1/2 border-4 border-transparent border-t-slate-800" />
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <Pagination
                total={filteredItems.length}
                page={safePage}
                perPage={perPage}
                onPage={setCurrentPage}
                onPerPage={setPerPage}
              />
            </>
          )}
        </div>

        {/* ── Info Footer ── */}
        <div className="flex items-start gap-3 rounded-2xl border border-blue-100 bg-blue-50 px-4 py-3">
          <svg className="mt-0.5 h-4 w-4 shrink-0 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
          <p className="text-xs text-blue-700">Items in trash are not permanently deleted. Restoring will return them to inventory. Logs and history remain intact.</p>
        </div>

      </div>
    </main>
  )
}
