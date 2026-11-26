'use client'

// Stock logs - the audit trail.
//
// Every movement of stock is recorded here: additions, deductions, transfers
// between New and Refurbished, sales, reservations, edits, voids and deletions.
// Each entry keeps who did it, when, the quantity before and after, and why.
//
// Tabs group the actions (see matchesTab below). The action names themselves
// are defined in lib/inventory/stockLogActions.ts.
//
// Nothing here is editable by design - an audit trail that can be edited is
// not an audit trail. Viewing requires the canViewStockLogs permission.

import { INPUT_LIMITS } from '@/lib/constants/limits'
import React, { useDeferredValue, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { collection, getDocs, orderBy, query, limit, where, Timestamp, type QueryDocumentSnapshot } from 'firebase/firestore'
import ProtectedRoute from '@/components/shared/ProtectedRoute'
import { db } from '@/lib/firebase'
import { getStockLogActionLabel, resolveStockLogAction, ResolvedStockLogAction, ALL_STOCK_LOG_ACTIONS } from '@/lib/inventory/stockLogActions'
import { toDate, toNumber } from '@/lib/server/salesInventoryMetrics'
import { UNIT_GRADES } from '@/lib/inventory/units'

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
// Actions on the item record itself, not on pieces.
const ITEM_LEVEL_ACTIONS: ResolvedStockLogAction[] = ['item_edited', 'item_deleted', 'item_restored', 'item_deleted_permanently']
const ITEM_UPDATE_ACTIONS = ['item_edited', 'condition_changed', 'item_added', 'item_deleted', 'item_restored', 'item_voided', 'item_unvoided', 'item_deleted_permanently']

function matchesTab(tab: TabId, action: ResolvedStockLogAction): boolean {
  if (tab === 'all') return true
  if (tab === 'stock_changes') return STOCK_CHANGE_ACTIONS.includes(action)
  if (tab === 'reservations_sales') return RESERVATION_SALE_ACTIONS(action)
  if (tab === 'item_updates') return ITEM_UPDATE_ACTIONS.includes(action)
  if (tab === 'system') return !STOCK_CHANGE_ACTIONS.includes(action) && !RESERVATION_SALE_ACTIONS(action) && !ITEM_UPDATE_ACTIONS.includes(action)
  return true
}

// One Firestore stock-log document as a table row.
function toStockLogRecord(doc: QueryDocumentSnapshot): StockLogRecord {
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
    // Per-piece logs written before pieces' conditions were stored only
    // carry the item's derived New/Refurbished label, which says nothing
    // about the piece that moved - show no condition rather than a wrong one.
    //
    // Edits, deletions and restores move no pieces; their stored condition is
    // the item's old New/Refurbished label ("Refurbished" on every per-piece
    // item), which describes nothing - so those rows show none.
    condition: (Array.isArray(data.unitCodes) && data.unitCodes.length > 0 && !Array.isArray(data.unitGrades)) ||
      ITEM_LEVEL_ACTIONS.includes(resolvedAction)
      ? ''
      : typeof data.condition === 'string' ? data.condition : '',
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
}

// Latest entries loaded on open, and the most one date range will load.
const RECENT_LIMIT = 500
const RANGE_LIMIT = 2000

const formatDate = (value: Date | null) => {
  if (!value) return 'Pending'
  return value.toLocaleString('en-PH', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// Row dates, split into day and time.
//
// Every row printing "Sep 20, 2026, 04:39 PM" made eight near-identical strings
// the widest thing on screen, and the part that actually differs - the time -
// was buried at the end. Today and yesterday are named instead of dated, which
// is how someone checking "what happened this afternoon" reads the page.
const formatLogDay = (value: Date | null, now: Date) => {
  if (!value) return 'Pending'

  const startOfToday = new Date(now); startOfToday.setHours(0, 0, 0, 0)
  const startOfYesterday = new Date(startOfToday); startOfYesterday.setDate(startOfYesterday.getDate() - 1)

  if (value >= startOfToday) return 'Today'
  if (value >= startOfYesterday) return 'Yesterday'

  // Within the same year the year adds nothing; across years it matters.
  return value.getFullYear() === now.getFullYear()
    ? value.toLocaleDateString('en-PH', { month: 'short', day: 'numeric' })
    : value.toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' })
}

const formatLogTime = (value: Date | null) =>
  value ? value.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' }) : ''

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
      case 'sale_refund':
        return 'bg-blue-100 text-blue-800'
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
      <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-sm font-semibold ${color}`}>
        {change > 0 ? '+' : ''}{change === 0 ? '—' : change}
      </span>
      {change !== 0 && <p className="mt-0.5 text-xs text-slate-500">{before} → {after}</p>}
      {change === 0 && <p className="mt-0.5 text-xs text-slate-500">N/A</p>}
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
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-slate-100 bg-white px-4 py-3 text-sm">
      <span className="text-slate-500">Showing {from} to {to} of <span className="font-semibold text-slate-700">{total}</span> logs</span>
      <div className="flex items-center gap-1.5">
        <select aria-label="Rows per page" value={perPage} onChange={e => { onPerPage(Number(e.target.value)); onPage(1) }}
          className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-sm text-slate-700 focus:outline-none">
          {[10, 25, 50].map(n => <option key={n} value={n}>{n}</option>)}
        </select>
        <button onClick={() => onPage(page - 1)} disabled={page === 1}
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 hover:bg-slate-50 disabled:opacity-40">
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
        </button>
        {pageNums.map((p, i) =>
          p === '...' ? (
            <span key={`e${i}`} className="flex h-8 w-8 items-center justify-center text-slate-500">…</span>
          ) : (
            <button key={p} onClick={() => onPage(p as number)}
              className={`flex h-8 w-8 items-center justify-center rounded-lg border text-sm font-medium transition ${page === p ? 'border-blue-600 bg-blue-600 text-white' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}>
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

  // The page opens on the latest RECENT_LIMIT entries: reading the whole trail
  // each time would cost one read per log ever written. A date range that
  // reaches further back than those entries asks the database for that range
  // instead - before, an older range filtered the recent entries and showed
  // nothing, as if no stock had moved.
  const [recentLogs, setRecentLogs] = useState<StockLogRecord[]>([])
  const [recentFull, setRecentFull] = useState(false) // true = there are older entries than loaded
  const [rangeLogs, setRangeLogs] = useState<StockLogRecord[] | null>(null)
  const [rangeFull, setRangeFull] = useState(false)
  const [rangeLoading, setRangeLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function loadLogs() {
      try {
        const snap = await getDocs(query(collection(db, 'stockLogs'), orderBy('createdAt', 'desc'), limit(RECENT_LIMIT)))
        if (cancelled) return
        setRecentLogs(snap.docs.map(toStockLogRecord).filter(r => r.resolvedAction !== 'unmapped_action'))
        setRecentFull(snap.size >= RECENT_LIMIT)
        setLoading(false)
      } catch (err) { console.error(err); setError('Failed to load stock logs.'); setLoading(false) }
    }
    loadLogs()
    return () => { cancelled = true }
  }, [])

  // Dates are local calendar days: "2026-11-01" means from local midnight.
  // (new Date('2026-11-01') is UTC midnight - 8 AM in Manila - which dropped
  // the first hours of the start day.)
  const rangeStartMs = startDate ? new Date(`${startDate}T00:00:00`).getTime() : null
  const rangeEndMs = endDate ? new Date(`${endDate}T23:59:59.999`).getTime() : null
  const oldestRecentMs = recentLogs.reduce((min, l) => Math.min(min, l.createdAt?.getTime() ?? min), Infinity)
  const needsRangeQuery =
    recentFull && (rangeStartMs != null || rangeEndMs != null) &&
    (rangeStartMs == null || rangeStartMs < oldestRecentMs)

  useEffect(() => {
    if (!needsRangeQuery) { setRangeLogs(null); return }
    let cancelled = false
    setRangeLoading(true)
    const parts = [
      ...(rangeStartMs != null ? [where('createdAt', '>=', Timestamp.fromMillis(rangeStartMs))] : []),
      ...(rangeEndMs != null ? [where('createdAt', '<=', Timestamp.fromMillis(rangeEndMs))] : []),
    ]
    getDocs(query(collection(db, 'stockLogs'), ...parts, orderBy('createdAt', 'desc'), limit(RANGE_LIMIT)))
      .then((snap) => {
        if (cancelled) return
        setRangeLogs(snap.docs.map(toStockLogRecord).filter(r => r.resolvedAction !== 'unmapped_action'))
        setRangeFull(snap.size >= RANGE_LIMIT)
      })
      .catch((err) => { if (!cancelled) { console.error(err); toast.error('Could not load logs for those dates.') } })
      .finally(() => { if (!cancelled) setRangeLoading(false) })
    return () => { cancelled = true }
  }, [needsRangeQuery, rangeStartMs, rangeEndMs])

  const logs = rangeLogs ?? recentLogs
  // Entries exist beyond what is on screen (shown as a note under the filters).
  const capped = rangeLogs ? rangeFull : recentFull && !needsRangeQuery && rangeStartMs == null

  // Show every action type the system supports, with a count of how many logs
  // currently match.
  //
  // Only actions that have actually occurred are listed. Showing all twenty with
  // "(0)" beside most of them made the reader scroll a long list to find the
  // three that existed, which is exactly the extra step to avoid. An action with
  // no records filters to an empty screen, so offering it is not useful.
  //
  // Sorted by frequency: the thing that happens most is the thing most likely
  // to be looked for.
  // Everything the date range, search and condition let through. The summary
  // cards and the action counts are read from this, so they describe the
  // same period the table shows - not the whole loaded trail.
  const inScope = useMemo(() => {
    const term = deferredSearch.trim().toLowerCase()
    return logs.filter(log => {
      const idx = [log.itemName, log.itemId, log.userName, log.userEmail, log.relatedId, log.previousValue, log.newValue, log.remarks, getStockLogActionLabel(log.resolvedAction)].join(' ').toLowerCase()
      const matchesSearch = !term || idx.includes(term)
      // A log can cover several conditions ("Good ×2, Fair").
      const matchesCond = conditionFilter === 'all' || log.condition.split(', ').map((c) => c.replace(/ ×\d+$/, '')).includes(conditionFilter)
      const t = log.createdAt?.getTime()
      const matchesDate = t == null ? rangeStartMs == null && rangeEndMs == null : (rangeStartMs == null || t >= rangeStartMs) && (rangeEndMs == null || t <= rangeEndMs)
      return matchesSearch && matchesCond && matchesDate
    })
  }, [logs, deferredSearch, conditionFilter, rangeStartMs, rangeEndMs])

  // The action list offers only actions inside the selected tab: an action
  // from another tab could only ever show an empty table.
  const tabLogs = useMemo(() => inScope.filter(log => matchesTab(activeTab, log.resolvedAction)), [inScope, activeTab])
  const actionOptions = useMemo(() => {
    const counts = tabLogs.reduce<Record<string, number>>((acc, l) => {
      acc[l.resolvedAction] = (acc[l.resolvedAction] ?? 0) + 1
      return acc
    }, {})
    return ALL_STOCK_LOG_ACTIONS
      .map(a => ({ action: a, count: counts[a] ?? 0 }))
      .filter(o => o.count > 0)
      .sort((a, b) => b.count - a.count)
  }, [tabLogs])

  const filteredLogs = useMemo(() => {
    return tabLogs
      .filter(log => actionFilter === 'all' || log.resolvedAction === actionFilter)
      .sort((a, b) => {
        const at = a.createdAt?.getTime() ?? 0
        const bt = b.createdAt?.getTime() ?? 0
        return sortDir === 'desc' ? bt - at : at - bt
      })
  }, [tabLogs, actionFilter, sortDir])

  // Switching tabs drops an action that belongs to another tab.
  const selectTab = (tab: TabId) => {
    setActiveTab(tab)
    if (actionFilter !== 'all' && !matchesTab(tab, actionFilter as ResolvedStockLogAction)) setActionFilter('all')
    setCurrentPage(1)
  }

  // Quick ranges. The audit trail is usually wanted for a period - "this week",
  // "last month" - rather than two dates typed by hand.
  const applyRange = (preset: 'today' | 'week' | 'month' | 'lastMonth' | 'all') => {
    const now = new Date()
    const iso = (d: Date) =>
      new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)

    setCurrentPage(1)
    if (preset === 'all') { setStartDate(''); setEndDate(''); return }

    let from = iso(now)
    let to = iso(now)
    if (preset === 'week') {
      // Monday start, matching the sales page
      const day = (now.getDay() + 6) % 7
      from = iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() - day))
    } else if (preset === 'month') {
      from = iso(new Date(now.getFullYear(), now.getMonth(), 1))
    } else if (preset === 'lastMonth') {
      from = iso(new Date(now.getFullYear(), now.getMonth() - 1, 1))
      to = iso(new Date(now.getFullYear(), now.getMonth(), 0))
    }
    setStartDate(from)
    setEndDate(to)
  }

  // ── Export the filtered log as CSV ──
  const exportLogsCsv = () => {
    const esc = (v: unknown) => {
      const str = String(v ?? '')
      return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str
    }
    const period =
      startDate || endDate ? `${startDate || 'any'} to ${endDate || 'any'}` : 'All dates'

    const meta = [
      ['SUSTAIN — Stock Log Export'],
      ['Period', period],
      ['Generated', new Date().toLocaleString('en-PH')],
      ['Entries', String(filteredLogs.length)],
      [],
    ]
    const headers = [
      'Date', 'Time', 'Item', 'Condition', 'Action',
      'Stock before', 'Change', 'Stock after', 'Processed by', 'Remarks',
    ]
    const rows = filteredLogs.map((log) => [
      log.createdAt ? log.createdAt.toLocaleDateString('en-PH') : '',
      log.createdAt ? log.createdAt.toLocaleTimeString('en-PH') : '',
      log.itemName,
      log.condition,
      getStockLogActionLabel(log.resolvedAction),
      log.stockBefore,
      log.quantityChanged,
      log.stockAfter,
      log.userName || log.userEmail,
      log.remarks,
    ])

    const csv = [...meta, headers, ...rows].map((r) => r.map(esc).join(',')).join('\n')
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `SUSTAIN-StockLogs-${startDate || 'all'}-to-${endDate || 'all'}.csv`
    a.click()
    URL.revokeObjectURL(url)
    toast.success(`Exported ${filteredLogs.length} log entr${filteredLogs.length === 1 ? 'y' : 'ies'}.`)
  }


  // Each card counts what its tab of the same name lists.
  const summary = useMemo(() => ({
    total: inScope.length,
    stockChanges: inScope.filter(l => matchesTab('stock_changes', l.resolvedAction)).length,
    itemUpdates: inScope.filter(l => matchesTab('item_updates', l.resolvedAction)).length,
    reservationAndSales: inScope.filter(l => matchesTab('reservations_sales', l.resolvedAction)).length,
  }), [inScope])

  const totalPages = Math.max(1, Math.ceil(filteredLogs.length / perPage))
  const safePage = Math.min(currentPage, totalPages)
  const paginatedLogs = filteredLogs.slice((safePage - 1) * perPage, safePage * perPage)

  const resetFilters = () => { setSearch(''); setActionFilter('all'); setConditionFilter('all'); setStartDate(''); setEndDate('') }

  const headerDate = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  const headerTime = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })

  return (
    <div className="flex min-h-[calc(100vh-64px)] flex-col bg-[#F1F5FC] px-3 py-3 sm:px-5 sm:py-4 md:min-h-screen">
      <div className="mx-auto flex min-h-0 w-full max-w-[1400px] flex-1 flex-col gap-3">

        {/* ── Header ── */}
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex items-center gap-3">
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-slate-900">Stock Logs</h1>
              <p className="text-xs text-slate-500">Track all inventory changes, item updates, reservations, and sales in one place.</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-slate-500">
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
            <svg className="h-4 w-4 shrink-0 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><circle cx="11" cy="11" r="8"/><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35"/></svg>
            <input aria-label="Search logs" maxLength={INPUT_LIMITS.search} type="text" value={search} onChange={e => { setSearch(e.target.value); setCurrentPage(1) }}
              placeholder="Search by item name, reference, user, or remarks..."
              className="w-full min-w-0 bg-transparent text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none" />
          </div>
          {/* Actions */}
          <select aria-label="Filter by action" value={actionFilter} onChange={e => { setActionFilter(e.target.value); setCurrentPage(1) }}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 focus:outline-none">
            <option value="all">All Actions ({tabLogs.length})</option>
            {actionOptions.map(({ action, count }) => (
              <option key={action} value={action}>
                {getStockLogActionLabel(action)} ({count})
              </option>
            ))}
          </select>
          {/* Conditions */}
          <select aria-label="Filter by condition" value={conditionFilter} onChange={e => { setConditionFilter(e.target.value); setCurrentPage(1) }}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 focus:outline-none">
            <option value="all">All Conditions</option>
            {UNIT_GRADES.map((g) => <option key={g} value={g}>{g}</option>)}
            <option value="Refurbished">Refurbished (older logs)</option>
          </select>
          {/* Quick ranges */}
          <select aria-label="Quick date range"
            onChange={(e) => { applyRange(e.target.value as 'today' | 'week' | 'month' | 'lastMonth' | 'all'); e.target.selectedIndex = 0 }}
            defaultValue=""
            title="Set the date range"
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 focus:outline-none">
            <option value="" disabled>Quick range…</option>
            <option value="today">Today</option>
            <option value="week">This week</option>
            <option value="month">This month</option>
            <option value="lastMonth">Last month</option>
            <option value="all">All dates</option>
          </select>
          {/* Date range */}
          <div className="flex items-center gap-1.5">
            <input aria-label="From date" type="date" value={startDate} max={endDate || undefined}
              onChange={e => { setStartDate(e.target.value); setCurrentPage(1) }}
              className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm text-slate-700 focus:outline-none" />
            <span className="text-slate-300">—</span>
            <input aria-label="To date" type="date" value={endDate} min={startDate || undefined}
              onChange={e => { setEndDate(e.target.value); setCurrentPage(1) }}
              className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm text-slate-700 focus:outline-none" />
          </div>
          {/* Export the filtered range */}
          <button
            type="button"
            onClick={exportLogsCsv}
            disabled={filteredLogs.length === 0}
            title="Download the filtered log entries as a CSV file"
            className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40">
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
            </svg>
            Export
          </button>
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
              <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Total Logs</p>
              <p className="text-2xl font-bold text-slate-900">{summary.total}</p>
              <p className="text-xs text-slate-500">Audit records</p>
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
              <p className="text-xs text-slate-500">Quantity adjustments</p>
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
              <p className="text-xs text-slate-500">Created &amp; modified</p>
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
              <p className="text-xs text-slate-500">Transactions</p>
            </div>
          </div>
        </div>

        {/* ── Table Card ── */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">

          {/* Tabs */}
          <div className="flex overflow-x-auto border-b border-slate-100 px-4">
            {TABS.map(tab => (
              <button key={tab.id} onClick={() => selectTab(tab.id)}
                className={`shrink-0 border-b-2 px-3 py-3 text-sm font-medium transition ${activeTab === tab.id ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>
                {tab.label}
              </button>
            ))}
          </div>

          {/* Error / Loading */}
          {error && <p className="px-4 py-3 text-sm text-red-600">{error}</p>}
          {!loading && !rangeLoading && capped && (
            <p className="border-b border-slate-100 bg-slate-50 px-4 py-2 text-xs text-slate-500">
              {rangeLogs
                ? `Showing the latest ${RANGE_LIMIT.toLocaleString()} entries in these dates. Narrow the dates to see earlier ones.`
                : `Showing the latest ${RECENT_LIMIT} entries. Choose dates to see older ones.`}
            </p>
          )}
          {loading || rangeLoading ? (
            <p className="px-4 py-8 text-center text-sm text-slate-500">Loading stock logs...</p>
          ) : filteredLogs.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-slate-500">No stock logs found.</p>
          ) : (
            <>
              {/* Table */}
              <div className="min-h-0 flex-1 overflow-auto">
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
                          <span title="Net quantity change to stock" className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-slate-300 text-[9px] font-semibold text-white cursor-default">i</span>
                        </span>
                      </th>
                      <th className="px-3 py-2.5 text-xs font-semibold uppercase tracking-wider text-slate-500">Performed By</th>
                      <th className="px-3 py-2.5 text-xs font-semibold uppercase tracking-wider text-slate-500">Reference / Notes</th>
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
                          {/* Only rows with stock before/after open; others had an
                              arrow that opened nothing. */}
                          <tr
                            onClick={hasDetail ? () => setExpandedId(isOpen ? null : log.id) : undefined}
                            className={`transition hover:bg-slate-50 ${hasDetail ? 'cursor-pointer' : ''}`}>
                            {/* Chevron - the whole row opens the details; this is the
                                same toggle as a button, so the keyboard can reach it
                                (the separate eye button in an Actions column is gone). */}
                            <td className="px-3 py-3 text-slate-500" onClick={e => e.stopPropagation()}>
                              {hasDetail && <button type="button" onClick={() => setExpandedId(isOpen ? null : log.id)}
                                aria-label={(isOpen ? 'Hide details for ' : 'Show details for ') + log.itemName} aria-expanded={isOpen}
                                className="flex h-5 w-5 items-center justify-center rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-300">
                                <svg className={`h-4 w-4 transition-transform ${isOpen ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                                </svg>
                              </button>}
                            </td>
                            {/* Date — day on top, time beneath, so the eye
                                scans the times rather than eight repetitions
                                of the same date. */}
                            <td className="whitespace-nowrap px-3 py-3">
                              <p className="font-semibold text-slate-800">{formatLogDay(log.createdAt, now)}</p>
                              <p className="text-xs text-slate-500">{formatLogTime(log.createdAt)}</p>
                            </td>
                            {/* Action */}
                            <td className="px-3 py-3"><ActionBadge action={log.resolvedAction} label={getStockLogActionLabel(log.resolvedAction)} /></td>
                            {/* Item */}
                            <td className="px-3 py-3">
                              {/* The database id used to be printed under every
                                  item name. It means nothing to the shop and it
                                  was the noisiest thing in the table. It is
                                  still searchable, and still shown in the
                                  expanded row for anyone tracing a record. */}
                              <p className="font-semibold text-slate-900">{log.itemName}</p>
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
                              {/* Name only. The email was a second line of grey
                                  text on every row that told the owner nothing
                                  she did not already know from the name; it is
                                  on hover, and still searchable. */}
                              <p className="font-semibold text-slate-800" title={log.userEmail || undefined}>{log.userName}</p>
                            </td>
                            {/* Notes */}
                            <td className="px-3 py-3 max-w-[200px]">
                              {/* The remark already names the receipt
                                  ("Sale SALE-20260920-0002 completed"), which
                                  is the reference the shop can actually look
                                  up. The raw document id below it was a second
                                  unreadable string saying the same thing. */}
                              {log.remarks ? <p className="text-sm text-slate-700">{log.remarks}</p> : <p className="text-slate-300">—</p>}
                            </td>
                          </tr>
                          {isOpen && hasDetail && (
                            <tr key={`${log.id}-exp`} className="bg-slate-50">
                              <td colSpan={7} className="px-8 py-3">
                                <div className="flex flex-wrap gap-6">
                                  {hasBefore && (
                                    <div>
                                      <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Before</p>
                                      <div className="flex flex-wrap items-center gap-2">
                                        <span className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm">
                                          <span className="text-xs text-slate-500">Stock</span>
                                          <span className="font-semibold text-slate-900">{log.stockBefore}</span>
                                        </span>
                                        <span className="inline-flex items-center gap-1.5 rounded-lg border border-violet-200 bg-violet-50 px-3 py-1.5 text-sm">
                                          <span className="text-xs text-violet-500">Reserved</span>
                                          <span className="font-semibold text-violet-800">{log.reservedBefore}</span>
                                        </span>
                                        <span className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm">
                                          <span className="text-xs text-slate-500">Available</span>
                                          <span className="font-semibold text-slate-900">{Math.max(0, log.stockBefore - log.reservedBefore)}</span>
                                        </span>
                                        {log.condition && (
                                          <span className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-sm">
                                            <span className="text-xs text-blue-500">Condition</span>
                                            <span className="font-semibold text-blue-700">{log.condition}</span>
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
                                      <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">After</p>
                                      <div className="flex flex-wrap items-center gap-2">
                                        <span className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm">
                                          <span className="text-xs text-slate-500">Stock</span>
                                          <span className="font-semibold text-slate-900">{log.stockAfter}</span>
                                        </span>
                                        <span className="inline-flex items-center gap-1.5 rounded-lg border border-violet-200 bg-violet-50 px-3 py-1.5 text-sm">
                                          <span className="text-xs text-violet-500">Reserved</span>
                                          <span className="font-semibold text-violet-800">{log.reservedAfter}</span>
                                        </span>
                                        <span className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm">
                                          <span className="text-xs text-slate-500">Available</span>
                                          <span className="font-semibold text-slate-900">{Math.max(0, log.stockAfter - log.reservedAfter)}</span>
                                        </span>
                                        {log.condition && (
                                          <span className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-sm">
                                            <span className="text-xs text-blue-500">Condition</span>
                                            <span className="font-semibold text-blue-700">{log.condition}</span>
                                          </span>
                                        )}
                                      </div>
                                    </div>
                                  )}
                                </div>

                                {/* Technical detail, out of the table and into
                                    the row you have to open on purpose. This is
                                    what an auditor traces a record by; it is not
                                    what the owner reads every day. */}
                                <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 border-t border-slate-200 pt-2 text-[11px] text-slate-500">
                                  <span>Recorded <span className="text-slate-600">{formatDate(log.createdAt)}</span></span>
                                  {log.userEmail && <span>By <span className="text-slate-600">{log.userEmail}</span></span>}
                                  <span>Item ID <span className="font-mono text-slate-600">{log.itemId}</span></span>
                                  {log.relatedId && <span>Reference <span className="font-mono text-slate-600">{log.relatedId}</span></span>}
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
    </div>
  )
}
