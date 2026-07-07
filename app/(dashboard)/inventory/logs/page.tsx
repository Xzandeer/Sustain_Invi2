'use client'

import React, { useDeferredValue, useEffect, useMemo, useState } from 'react'
import { collection, getDocs, orderBy, query, limit } from 'firebase/firestore'
import ProtectedRoute from '@/components/shared/ProtectedRoute'
import { db } from '@/lib/firebase'
import { getStockLogActionLabel, resolveStockLogAction, ResolvedStockLogAction } from '@/lib/inventory/stockLogActions'
import { toDate, toNumber } from '@/lib/server/salesInventoryMetrics'

interface StockLogRecord {
  id: string
  actionType: string
  resolvedAction: ResolvedStockLogAction
  itemId: string
  itemName: string
  condition: string
  previousValue: string
  newValue: string
  quantityBefore: number
  quantityChanged: number
  quantityAfter: number
  stockBefore: number
  stockAfter: number
  reservedBefore: number
  reservedAfter: number
  userName: string
  userEmail: string
  relatedId: string
  remarks: string
  createdAt: Date | null
}

type TabId = 'all' | 'stock_changes' | 'reservations_sales' | 'item_updates' | 'system'

const TABS: { id: TabId; label: string }[] = [
  { id: 'all', label: 'All Logs' },
  { id: 'stock_changes', label: 'Stock Changes' },
  { id: 'reservations_sales', label: 'Reservations & Sales' },
  { id: 'item_updates', label: 'Item Updates' },
  { id: 'system', label: 'System' },
]

const STOCK_CHANGE_ACTIONS = ['stock_increased', 'stock_decreased', 'stock_transferred_in', 'stock_transferred_out']
const RESERVATION_SALE_ACTIONS = (a: ResolvedStockLogAction) => a.includes('reservation') || a.includes('sale')
const ITEM_UPDATE_ACTIONS = ['item_edited', 'condition_changed', 'item_added', 'item_deleted', 'item_restored', 'item_voided', 'item_unvoided', 'item_deleted_permanently']

function matchesTab(tab: TabId, action: ResolvedStockLogAction): boolean {
  if (tab === 'all') return true
  if (tab === 'stock_changes') return STOCK_CHANGE_ACTIONS.includes(action)
  if (tab === 'reservations_sales') return RESERVATION_SALE_ACTIONS(action)
  if (tab === 'item_updates') return ITEM_UPDATE_ACTIONS.includes(action)
  if (tab === 'system') return !STOCK_CHANGE_ACTIONS.includes(action) && !RESERVATION_SALE_ACTIONS(action) && !ITEM_UPDATE_ACTIONS.includes(action)
  return true
}

const formatDate = (value: Date | null) => {
  if (!value) return 'Pending'
  return value.toLocaleString('en-PH', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function useNow() {
  const [now, setNow] = useState(new Date())
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 60000); return () => clearInterval(t) }, [])
  return now
}

function ActionBadge({ action, label }: { action: ResolvedStockLogAction; label: string }) {
  const cls = (() => {
    switch (action) {
      case 'stock_increased': case 'item_added': case 'stock_transferred_in': case 'reservation_release':
        return 'bg-emerald-100 text-emerald-800'
      case 'stock_decreased': case 'sale_deduction': case 'reservation_deduction': case 'reservation_claim': case 'stock_transferred_out':
        return 'bg-amber-100 text-amber-800'
      case 'condition_changed': case 'item_edited':
        return 'bg-sky-100 text-sky-800'
      case 'item_deleted': case 'item_restored':
        return 'bg-slate-100 text-slate-700'
      default: return 'bg-slate-100 text-slate-700'
    }
  })()
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ${cls}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
      {label}
    </span>
  )
}

function QtyBadge({ change, before, after }: { change: number; before: number; after: number }) {
  const color = change > 0 ? 'bg-emerald-50 text-emerald-700' : change < 0 ? 'bg-amber-50 text-amber-700' : 'bg-slate-50 text-slate-600'
  return (
    <div>
      <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-sm font-bold ${color}`}>
        {change > 0 ? '+' : ''}{change === 0 ? '—' : change}
      </span>
      {change !== 0 && <p className="mt-0.5 text-xs text-slate-400">{before} → {after}</p>}
      {change === 0 && <p className="mt-0.5 text-xs text-slate-400">N/A</p>}
    </div>
  )
}

function Pagination({ total, page, perPage, onPage, onPerPage }: { total: number; page: number; perPage: number; onPage: (p: number) => void; onPerPage: (n: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / perPage))
  const from = Math.min(total, (page - 1) * perPage + 1)
  const to = Math.min(total, page * perPage)

  const pageNums: (number | '...')[] = []
  if (pages <= 7) {
    for (let i = 1; i <= pages; i++) pageNums.push(i)
  } else {
    pageNums.push(1)
    if (page > 3) pageNums.push('...')
    for (let i = Math.max(2, page - 1); i <= Math.min(pages - 1, page + 1); i++) pageNums.push(i)
    if (page < pages - 2) pageNums.push('...')
    pageNums.push(pages)
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-4 py-3 text-sm">
      <span className="text-slate-500">Showing {from} to {to} of <span className="font-semibold text-slate-700">{total}</span> logs</span>
      <div className="flex items-center gap-1.5">
        <select value={perPage} onChange={e => { onPerPage(Number(e.target.value)); onPage(1) }}
          className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-sm text-slate-700 focus:outline-none">
          {[10, 25, 50].map(n => <option key={n} value={n}>{n}</option>)}
        </select>
        <button onClick={() => onPage(page - 1)} disabled={page === 1}
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 hover:bg-slate-50 disabled:opacity-40">
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
        </button>
        {pageNums.map((p, i) =>
          p === '...' ? (
            <span key={`e${i}`} className="flex h-8 w-8 items-center justify-center text-slate-400">…</span>
          ) : (
            <button key={p} onClick={() => onPage(p as number)}
              className={`flex h-8 w-8 items-center justify-center rounded-lg border text-sm font-medium transition ${page === p ? 'border-[#1e3a5f] bg-[#1e3a5f] text-white' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}>
              {p}
            </button>
          )
        )}
        <button onClick={() => onPage(page + 1)} disabled={page === pages}
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 hover:bg-slate-50 disabled:opacity-40">
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
        </button>
      </div>
    </div>
  )
}

export default function InventoryLogsPage() {
  return (
    <ProtectedRoute allowStockLogs>
      <InventoryLogsContent />
    </ProtectedRoute>
  )
}

function InventoryLogsContent() {
  const [logs, setLogs] = useState<StockLogRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [actionFilter, setActionFilter] = useState('all')
  const [conditionFilter, setConditionFilter] = useState('all')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [activeTab, setActiveTab] = useState<TabId>('all')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [perPage, setPerPage] = useState(10)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const deferredSearch = useDeferredValue(search)
  const now = useNow()

  useEffect(() => {
    let cancelled = false
    async function loadLogs() {
      try {
        // Limit to 500 most recent logs to avoid reading the entire collection on every load
        const snap = await getDocs(query(collection(db, 'stockLogs'), orderBy('createdAt', 'desc'), limit(500)))
        if (cancelled) return
        const records = snap.docs.map((doc) => {
          const data = doc.data() as Record<string, unknown>
          const actionType = typeof data.actionType === 'string' ? data.actionType : ''
          const resolvedAction = resolveStockLogAction({
            actionType, remarks: data.remarks,
            quantityChanged: toNumber(data.quantityChanged, 0),
            stockBefore: toNumber(data.stockBefore, 0), stockAfter: toNumber(data.stockAfter, 0),
            reservedBefore: toNumber(data.reservedBefore, 0), reservedAfter: toNumber(data.reservedAfter, 0),
          })
          return {
            id: doc.id, actionType, resolvedAction,
            itemId: typeof data.itemId === 'string' ? data.itemId : '',
            itemName: typeof data.itemName === 'string' ? data.itemName : 'Unnamed Item',
            condition: typeof data.condition === 'string' ? data.condition : 'Unknown',
            previousValue: typeof data.previousValue === 'string' ? data.previousValue : '',
            newValue: typeof data.newValue === 'string' ? data.newValue : '',
            quantityBefore: toNumber(data.quantityBefore, 0),
            quantityChanged: toNumber(data.quantityChanged, 0),
            quantityAfter: toNumber(data.quantityAfter, 0),
            stockBefore: toNumber(data.stockBefore, 0), stockAfter: toNumber(data.stockAfter, 0),
            reservedBefore: toNumber(data.reservedBefore, 0), reservedAfter: toNumber(data.reservedAfter, 0),
            userName: typeof data.userName === 'string' && data.userName.trim() ? data.userName : 'System User',
            userEmail: typeof data.userEmail === 'string' ? data.userEmail.trim() : '',
            relatedId: typeof data.relatedId === 'string' ? data.relatedId.trim() : '',
            remarks: typeof data.remarks === 'string' ? data.remarks : '',
            createdAt: toDate(data.createdAt),
          } satisfies StockLogRecord
        })
        setLogs(records.filter(r => r.resolvedAction !== 'unmapped_action'))
        setLoading(false)
      } catch (err) { console.error(err); setError('Failed to load stock logs.'); setLoading(false) }
    }
    loadLogs()
    return () => { cancelled = true }
  }, [])

  const actionOptions = useMemo(() =>
    Array.from(new Set(logs.map(l => l.resolvedAction))).filter(a => a !== 'unmapped_action').sort((a, b) => a.localeCompare(b))
  , [logs])

  const filteredLogs = useMemo(() => {
    const term = deferredSearch.trim().toLowerCase()
    const startTime = startDate ? new Date(startDate).getTime() : null
    const endTime = endDate ? new Date(new Date(endDate).setHours(23, 59, 59, 999)).getTime() : null

    return logs.filter(log => {
      const idx = [log.itemName, log.itemId, log.userName, log.userEmail, log.relatedId, log.previousValue, log.newValue, log.remarks, getStockLogActionLabel(log.resolvedAction)].join(' ').toLowerCase()
      const matchesSearch = !term || idx.includes(term)
      const matchesAction = actionFilter === 'all' || log.resolvedAction === actionFilter
      const matchesCond = conditionFilter === 'all' || log.condition === conditionFilter
      const t = log.createdAt?.getTime()
      const matchesDate = t == null ? !startTime && !endTime : (startTime == null || t >= startTime) && (endTime == null || t <= endTime)
      const tabMatch = matchesTab(activeTab, log.resolvedAction)
      return matchesSearch && matchesAction && matchesCond && matchesDate && tabMatch
    }).sort((a, b) => {
      const at = a.createdAt?.getTime() ?? 0
      const bt = b.createdAt?.getTime() ?? 0
      return sortDir === 'desc' ? bt - at : at - bt
    })
  }, [logs, deferredSearch, actionFilter, conditionFilter, startDate, endDate, activeTab, sortDir])


  const summary = useMemo(() => ({
    total: logs.filter(l => l.resolvedAction !== 'unmapped_action').length,
    stockChanges: logs.filter(l => l.quantityChanged !== 0).length,
    itemUpdates: logs.filter(l => ITEM_UPDATE_ACTIONS.includes(l.resolvedAction)).length,
    reservationAndSales: logs.filter(l => RESERVATION_SALE_ACTIONS(l.resolvedAction)).length,
  }), [logs])

  const totalPages = Math.max(1, Math.ceil(filteredLogs.length / perPage))
  const safePage = Math.min(currentPage, totalPages)
  const paginatedLogs = filteredLogs.slice((safePage - 1) * perPage, safePage * perPage)

  const resetFilters = () => { setSearch(''); setActionFilter('all'); setConditionFilter('all'); setStartDate(''); setEndDate('') }

  const headerDate = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  const headerTime = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })

  return (
    <main className="min-h-[calc(100vh-64px)] bg-slate-50 px-3 py-3 sm:px-5 sm:py-4">
      <div className="mx-auto max-w-[1400px] space-y-3">

        {/* ── Header ── */}
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
            </div>
            <div>
              <h1 className="text-lg font-bold text-slate-900 sm:text-xl">Stock Logs</h1>
              <p className="text-xs text-slate-500">Track all inventory changes, item updates, reservations, and sales in one place.</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-slate-400">
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
            <span>{headerDate}</span>
            <span className="text-slate-300">·</span>
            <span className="font-medium text-slate-600">{headerTime}</span>
          </div>
        </div>

        {/* ── Filter bar ── */}
        <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-2.5 shadow-sm">
          {/* Search */}
          <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-slate-200 px-3 py-1.5">
            <svg className="h-4 w-4 shrink-0 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><circle cx="11" cy="11" r="8"/><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35"/></svg>
            <input type="text" value={search} onChange={e => { setSearch(e.target.value); setCurrentPage(1) }}
              placeholder="Search by item name, reference, user, or remarks..."
              className="w-full min-w-0 bg-transparent text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none" />
          </div>
          {/* Actions */}
          <select value={actionFilter} onChange={e => { setActionFilter(e.target.value); setCurrentPage(1) }}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 focus:outline-none">
            <option value="all">All Actions</option>
            {actionOptions.map(a => <option key={a} value={a}>{getStockLogActionLabel(a)}</option>)}
          </select>
          {/* Conditions */}
          <select value={conditionFilter} onChange={e => { setConditionFilter(e.target.value); setCurrentPage(1) }}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 focus:outline-none">
            <option value="all">All Conditions</option>
            <option value="New">New</option>
            <option value="Refurbished">Refurbished</option>
          </select>
          {/* Date range */}
          <div className="flex items-center gap-1.5">
            <input type="date" value={startDate} max={endDate || undefined}
              onChange={e => { setStartDate(e.target.value); setCurrentPage(1) }}
              className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm text-slate-700 focus:outline-none" />
            <span className="text-slate-300">—</span>
            <input type="date" value={endDate} min={startDate || undefined}
              onChange={e => { setEndDate(e.target.value); setCurrentPage(1) }}
              className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm text-slate-700 focus:outline-none" />
          </div>
          {/* Reset */}
          <button onClick={resetFilters}
            className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-600 transition hover:bg-slate-50">
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
            Reset
          </button>
        </div>

        {/* ── KPI Cards ── */}
        <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
          {/* Total Logs */}
          <div className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white p-3 sm:p-4 shadow-sm">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-slate-100">
              <svg className="h-6 w-6 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Total Logs</p>
              <p className="text-2xl font-bold text-slate-900">{summary.total}</p>
              <p className="text-xs text-slate-400">Audit records</p>
            </div>
          </div>
          {/* Stock Changes */}
          <div className="flex items-center gap-3 rounded-2xl border border-emerald-100 bg-white p-3 sm:p-4 shadow-sm">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-emerald-100">
              <svg className="h-6 w-6 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4" />
              </svg>
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-500">Stock Changes</p>
              <p className="text-2xl font-bold text-slate-900">{summary.stockChanges}</p>
              <p className="text-xs text-slate-400">Quantity adjustments</p>
            </div>
          </div>
          {/* Item Updates */}
          <div className="flex items-center gap-3 rounded-2xl border border-violet-100 bg-white p-3 sm:p-4 shadow-sm">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-violet-100">
              <svg className="h-6 w-6 text-violet-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-violet-500">Item Updates</p>
              <p className="text-2xl font-bold text-slate-900">{summary.itemUpdates}</p>
              <p className="text-xs text-slate-400">Created &amp; modified</p>
            </div>
          </div>
          {/* Reservations & Sales */}
          <div className="flex items-center gap-3 rounded-2xl border border-amber-100 bg-white p-3 sm:p-4 shadow-sm">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-amber-100">
              <svg className="h-6 w-6 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" />
              </svg>
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-amber-500">Reservations &amp; Sales</p>
              <p className="text-2xl font-bold text-slate-900">{summary.reservationAndSales}</p>
              <p className="text-xs text-slate-400">Transactions</p>
            </div>
          </div>
        </div>

        {/* ── Table Card ── */}
        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">

          {/* Tabs */}
          <div className="flex overflow-x-auto border-b border-slate-100 px-4">
            {TABS.map(tab => (
              <button key={tab.id} onClick={() => { setActiveTab(tab.id); setCurrentPage(1) }}
                className={`shrink-0 border-b-2 px-3 py-3 text-sm font-medium transition ${activeTab === tab.id ? 'border-[#1e3a5f] text-[#1e3a5f]' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>
                {tab.label}
              </button>
            ))}
          </div>

          {/* Error / Loading */}
          {error && <p className="px-4 py-3 text-sm text-red-600">{error}</p>}
          {loading ? (
            <p className="px-4 py-8 text-center text-sm text-slate-400">Loading stock logs...</p>
          ) : filteredLogs.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-slate-400">No stock logs found.</p>
          ) : (
            <>
              {/* Table */}
              <div className="overflow-x-auto">
                <table className="w-full min-w-[800px] text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 bg-slate-50 text-left">
                      <th className="w-6 px-3 py-2.5" />
                      <th className="px-3 py-2.5">
                        <button onClick={() => setSortDir(d => d === 'desc' ? 'asc' : 'desc')}
                          className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-slate-500 hover:text-slate-700">
                          Date &amp; Time
                          <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d={sortDir === 'desc' ? 'M19 9l-7 7-7-7' : 'M5 15l7-7 7 7'} />
                          </svg>
                        </button>
                      </th>
                      <th className="px-3 py-2.5 text-xs font-semibold uppercase tracking-wider text-slate-500">Action</th>
                      <th className="px-3 py-2.5 text-xs font-semibold uppercase tracking-wider text-slate-500">Item</th>
                      <th className="px-3 py-2.5 text-xs font-semibold uppercase tracking-wider text-slate-500">
                        <span className="flex items-center gap-1">Qty Change
                          <span title="Net quantity change to stock" className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-slate-300 text-[9px] font-bold text-white cursor-default">i</span>
                        </span>
                      </th>
                      <th className="px-3 py-2.5 text-xs font-semibold uppercase tracking-wider text-slate-500">Performed By</th>
                      <th className="px-3 py-2.5 text-xs font-semibold uppercase tracking-wider text-slate-500">Reference / Notes</th>
                      <th className="px-3 py-2.5 text-xs font-semibold uppercase tracking-wider text-slate-500">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {paginatedLogs.map(log => {
                      const isOpen = expandedId === log.id
                      const hasBefore = log.stockBefore > 0 || log.reservedBefore > 0
                      const hasAfter = log.stockAfter > 0 || log.reservedAfter > 0
                      const hasDetail = hasBefore || hasAfter
                      return (
                        <React.Fragment key={log.id}>
                          <tr
                            onClick={() => setExpandedId(isOpen ? null : log.id)}
                            className="cursor-pointer transition hover:bg-slate-50">
                            {/* Chevron */}
                            <td className="px-3 py-3 text-slate-400">
                              <svg className={`h-4 w-4 transition-transform ${isOpen ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                              </svg>
                            </td>
                            {/* Date */}
                            <td className="whitespace-nowrap px-3 py-3 font-medium text-slate-800">{formatDate(log.createdAt)}</td>
                            {/* Action */}
                            <td className="px-3 py-3"><ActionBadge action={log.resolvedAction} label={getStockLogActionLabel(log.resolvedAction)} /></td>
                            {/* Item */}
                            <td className="px-3 py-3">
                              <p className="font-semibold text-slate-900">{log.itemName}</p>
                              <p className="font-mono text-[11px] text-slate-400">{log.itemId.slice(0, 16)}</p>
                              {log.condition && (
                                <span className="mt-1 inline-block rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-600">{log.condition}</span>
                              )}
                            </td>
                            {/* Qty */}
                            <td className="px-3 py-3">
                              <QtyBadge change={log.quantityChanged} before={log.quantityBefore} after={log.quantityAfter} />
                            </td>
                            {/* Performed by */}
                            <td className="px-3 py-3">
                              <p className="font-semibold text-slate-800">{log.userName}</p>
                              {log.userEmail && <p className="text-xs text-slate-400 truncate max-w-[160px]">{log.userEmail}</p>}
                            </td>
                            {/* Notes */}
                            <td className="px-3 py-3 max-w-[200px]">
                              {log.remarks ? <p className="text-sm text-slate-700">{log.remarks}</p> : <p className="text-slate-300">—</p>}
                              {log.relatedId && <p className="mt-0.5 font-mono text-[11px] text-slate-400">Ref: {log.relatedId.slice(0, 20)}{log.relatedId.length > 20 ? ' …' : ''}</p>}
                            </td>
                            {/* Actions */}
                            <td className="px-3 py-3" onClick={e => e.stopPropagation()}>
                              <button onClick={() => setExpandedId(isOpen ? null : log.id)}
                                className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 text-slate-400 transition hover:border-slate-300 hover:text-slate-600">
                                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                              </button>
                            </td>
                          </tr>
                          {isOpen && hasDetail && (
                            <tr key={`${log.id}-exp`} className="bg-slate-50">
                              <td colSpan={8} className="px-8 py-3">
                                <div className="flex flex-wrap gap-6">
                                  {hasBefore && (
                                    <div>
                                      <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400">Before</p>
                                      <div className="flex flex-wrap items-center gap-2">
                                        <span className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm">
                                          <span className="text-xs text-slate-500">Stock</span>
                                          <span className="font-bold text-slate-900">{log.stockBefore}</span>
                                        </span>
                                        <span className="inline-flex items-center gap-1.5 rounded-lg border border-violet-200 bg-violet-50 px-3 py-1.5 text-sm">
                                          <span className="text-xs text-violet-500">Reserved</span>
                                          <span className="font-bold text-violet-800">{log.reservedBefore}</span>
                                        </span>
                                        <span className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm">
                                          <span className="text-xs text-slate-500">Available</span>
                                          <span className="font-bold text-slate-900">{Math.max(0, log.stockBefore - log.reservedBefore)}</span>
                                        </span>
                                        {log.condition && (
                                          <span className="inline-flex items-center gap-1.5 rounded-lg border border-sky-200 bg-sky-50 px-3 py-1.5 text-sm">
                                            <span className="text-xs text-sky-500">Condition</span>
                                            <span className="font-bold text-sky-800">{log.condition}</span>
                                          </span>
                                        )}
                                      </div>
                                    </div>
                                  )}
                                  {hasBefore && hasAfter && (
                                    <div className="flex items-center self-center text-slate-300">
                                      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M17 8l4 4m0 0l-4 4m4-4H3" /></svg>
                                    </div>
                                  )}
                                  {hasAfter && (
                                    <div>
                                      <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400">After</p>
                                      <div className="flex flex-wrap items-center gap-2">
                                        <span className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm">
                                          <span className="text-xs text-slate-500">Stock</span>
                                          <span className="font-bold text-slate-900">{log.stockAfter}</span>
                                        </span>
                                        <span className="inline-flex items-center gap-1.5 rounded-lg border border-violet-200 bg-violet-50 px-3 py-1.5 text-sm">
                                          <span className="text-xs text-violet-500">Reserved</span>
                                          <span className="font-bold text-violet-800">{log.reservedAfter}</span>
                                        </span>
                                        <span className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm">
                                          <span className="text-xs text-slate-500">Available</span>
                                          <span className="font-bold text-slate-900">{Math.max(0, log.stockAfter - log.reservedAfter)}</span>
                                        </span>
                                        {log.condition && (
                                          <span className="inline-flex items-center gap-1.5 rounded-lg border border-sky-200 bg-sky-50 px-3 py-1.5 text-sm">
                                            <span className="text-xs text-sky-500">Condition</span>
                                            <span className="font-bold text-sky-800">{log.condition}</span>
                                          </span>
                                        )}
                                      </div>
                                    </div>
                                  )}
                                </div>
                              </td>
                            </tr>
                          )}
                      </React.Fragment>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              <Pagination
                total={filteredLogs.length}
                page={safePage}
                perPage={perPage}
                onPage={p => setCurrentPage(p)}
                onPerPage={n => setPerPage(n)}
              />
            </>
          )}
        </div>
      </div>
    </main>
  )
}
