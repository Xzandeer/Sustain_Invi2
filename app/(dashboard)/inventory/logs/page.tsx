'use client'

import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import { collection, onSnapshot, orderBy, query } from 'firebase/firestore'
import ProtectedRoute from '@/components/ProtectedRoute'
import { ActionBadge, QuantityChange, StockValueDisplay } from '@/components/StockLogComponents'
import { db } from '@/lib/firebase'
import { getStockLogActionLabel, resolveStockLogAction, ResolvedStockLogAction } from '@/lib/stockLogActions'
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

const formatDate = (value: Date | null) => {
  if (!value) return 'Pending timestamp'
  return value.toLocaleString('en-PH', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
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
  const deferredSearch = useDeferredValue(search)

  useEffect(() => {
    const logsQuery = query(collection(db, 'stockLogs'), orderBy('createdAt', 'desc'))

    const unsubscribe = onSnapshot(
      logsQuery,
      (snapshot) => {
        const records = snapshot.docs.map((logDoc) => {
          const data = logDoc.data() as Record<string, unknown>
          const actionType = typeof data.actionType === 'string' ? data.actionType : ''
          const resolvedAction = resolveStockLogAction({
            actionType,
            remarks: data.remarks,
            quantityChanged: toNumber(data.quantityChanged, 0),
            stockBefore: toNumber(data.stockBefore, 0),
            stockAfter: toNumber(data.stockAfter, 0),
            reservedBefore: toNumber(data.reservedBefore, 0),
            reservedAfter: toNumber(data.reservedAfter, 0),
          })

          return {
            id: logDoc.id,
            actionType,
            resolvedAction,
            itemId: typeof data.itemId === 'string' ? data.itemId : '',
            itemName: typeof data.itemName === 'string' ? data.itemName : 'Unnamed Item',
            condition: typeof data.condition === 'string' ? data.condition : 'Unknown',
            previousValue: typeof data.previousValue === 'string' ? data.previousValue : '',
            newValue: typeof data.newValue === 'string' ? data.newValue : '',
            quantityBefore: toNumber(data.quantityBefore, 0),
            quantityChanged: toNumber(data.quantityChanged, 0),
            quantityAfter: toNumber(data.quantityAfter, 0),
            stockBefore: toNumber(data.stockBefore, 0),
            stockAfter: toNumber(data.stockAfter, 0),
            reservedBefore: toNumber(data.reservedBefore, 0),
            reservedAfter: toNumber(data.reservedAfter, 0),
            userName: typeof data.userName === 'string' && data.userName.trim() ? data.userName : 'System User',
            userEmail: typeof data.userEmail === 'string' ? data.userEmail.trim() : '',
            relatedId: typeof data.relatedId === 'string' ? data.relatedId.trim() : '',
            remarks: typeof data.remarks === 'string' ? data.remarks : '',
            createdAt: toDate(data.createdAt),
          } satisfies StockLogRecord
        })

        setLogs(records.filter((log) => log.resolvedAction !== 'unmapped_action'))
        setLoading(false)
      },
      (snapshotError) => {
        console.error('Failed to load stock logs:', snapshotError)
        setError('Failed to load stock logs.')
        setLoading(false)
      }
    )

    return () => unsubscribe()
  }, [])

  const actionOptions = useMemo(
    () =>
      Array.from(new Set(logs.map((log) => log.resolvedAction)))
        .filter((action) => action !== 'unmapped_action')
        .sort((a, b) => a.localeCompare(b)),
    [logs]
  )

  const filteredLogs = useMemo(() => {
    const searchTerm = deferredSearch.trim().toLowerCase()
    const startTime = startDate ? new Date(startDate).getTime() : null
    const endTime = endDate ? new Date(new Date(endDate).setHours(23, 59, 59, 999)).getTime() : null

    return logs.filter((log) => {
      const searchIndex = [
        log.itemName,
        log.itemId,
        log.userName,
        log.userEmail,
        log.relatedId,
        log.previousValue,
        log.newValue,
        log.remarks,
        getStockLogActionLabel(log.resolvedAction),
      ]
        .join(' ')
        .toLowerCase()

      const matchesSearch = !searchTerm || searchIndex.includes(searchTerm)
      const matchesAction = actionFilter === 'all' ? true : log.resolvedAction === actionFilter
      const matchesCondition = conditionFilter === 'all' ? true : log.condition === conditionFilter
      const createdTime = log.createdAt?.getTime()
      const matchesDate =
        createdTime == null
          ? !startTime && !endTime
          : (startTime == null || createdTime >= startTime) && (endTime == null || createdTime <= endTime)

      return matchesSearch && matchesAction && matchesCondition && matchesDate
    })
  }, [logs, deferredSearch, actionFilter, conditionFilter, startDate, endDate])

  const summary = useMemo(
    () => ({
      total: filteredLogs.length,
      stockChanges: filteredLogs.filter((log) => log.quantityChanged !== 0).length,
      itemUpdates: filteredLogs.filter((log) => log.resolvedAction === 'item_edited' || log.resolvedAction === 'condition_changed').length,
      reservationAndSales: filteredLogs.filter((log) => log.resolvedAction.includes('reservation') || log.resolvedAction.includes('sale')).length,
    }),
    [filteredLogs]
  )

  return (
    <main className="min-h-[calc(100vh-64px)] bg-slate-100 px-2.5 py-3 sm:px-3">
      <div className="mx-auto max-w-[1620px] space-y-4">
        <header>
          <h1 className="text-[1.65rem] font-bold text-slate-900">Stock Logs</h1>
        </header>

        <section className="rounded-xl border bg-white p-4 shadow-sm">
          <div className="mb-4 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            <input
              type="text"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Item name, reference number, user, or remarks"
              className="w-full rounded-lg border border-slate-300 px-3.5 py-2 text-sm text-slate-900 outline-none transition focus:border-slate-500 md:col-span-2"
            />
            <select
              value={actionFilter}
              onChange={(event) => setActionFilter(event.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-slate-500"
            >
              <option value="all">All Actions</option>
              {actionOptions.map((action) => (
                <option key={action} value={action}>
                  {getStockLogActionLabel(action)}
                </option>
              ))}
            </select>
            <select
              value={conditionFilter}
              onChange={(event) => setConditionFilter(event.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-slate-500"
            >
              <option value="all">All Conditions</option>
              <option value="New">New</option>
              <option value="Refurbished">Refurbished</option>
              <option value="Unknown">Unknown</option>
            </select>
            <input
              type="date"
              value={startDate}
              max={endDate || undefined}
              onChange={(event) => {
                const nextStartDate = event.target.value
                setStartDate(nextStartDate)
                if (endDate && nextStartDate && new Date(endDate) < new Date(nextStartDate)) {
                  setEndDate(nextStartDate)
                }
              }}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-slate-500"
            />
            <input
              type="date"
              value={endDate}
              min={startDate || undefined}
              onChange={(event) => setEndDate(event.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-slate-500"
            />
          </div>

          <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-lg border border-slate-200 bg-linear-to-br from-slate-50 to-slate-100/50 px-4 py-4 shadow-sm transition hover:shadow-md">
              <p className="text-xs font-semibold uppercase tracking-widest text-slate-600">Total Logs</p>
              <p className="mt-3 text-3xl font-bold text-slate-900">{summary.total}</p>
              <p className="mt-2 text-xs text-slate-500">Audit records</p>
            </div>
            <div className="rounded-lg border border-emerald-200 bg-linear-to-br from-emerald-50 to-emerald-100/50 px-4 py-4 shadow-sm transition hover:shadow-md">
              <p className="text-xs font-semibold uppercase tracking-widest text-emerald-700">Stock Changes</p>
              <p className="mt-3 text-3xl font-bold text-emerald-900">{summary.stockChanges}</p>
              <p className="mt-2 text-xs text-emerald-600">Quantity adjustments</p>
            </div>
            <div className="rounded-lg border border-sky-200 bg-linear-to-br from-sky-50 to-sky-100/50 px-4 py-4 shadow-sm transition hover:shadow-md">
              <p className="text-xs font-semibold uppercase tracking-widest text-sky-700">Item Updates</p>
              <p className="mt-3 text-3xl font-bold text-sky-900">{summary.itemUpdates}</p>
              <p className="mt-2 text-xs text-sky-600">Created & modified</p>
            </div>
            <div className="rounded-lg border border-amber-200 bg-linear-to-br from-amber-50 to-amber-100/50 px-4 py-4 shadow-sm transition hover:shadow-md">
              <p className="text-xs font-semibold uppercase tracking-widest text-amber-700">Reservations & Sales</p>
              <p className="mt-3 text-3xl font-bold text-amber-900">{summary.reservationAndSales}</p>
              <p className="mt-2 text-xs text-amber-600">Transactions</p>
            </div>
          </div>

          {error ? <p className="mb-3 text-sm text-red-600">{error}</p> : null}
          {loading ? (
            <p className="text-sm text-slate-500">Loading stock logs...</p>
          ) : filteredLogs.length === 0 ? (
            <p className="text-sm text-slate-500">No stock logs found.</p>
          ) : (
            <div className="space-y-3">
              {filteredLogs.map((log) => (
                <div key={log.id} className="rounded-lg border border-slate-200 bg-white p-4 transition hover:border-slate-300 hover:shadow-sm">
                  <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
                    <div>
                      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500">Date & Time</p>
                      <p className="text-sm font-semibold text-slate-900">{formatDate(log.createdAt)}</p>
                    </div>

                    <div>
                      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500">Action</p>
                      <ActionBadge action={log.resolvedAction} label={getStockLogActionLabel(log.resolvedAction)} />
                    </div>

                    <div>
                      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500">Item Details</p>
                      <div className="space-y-1">
                        <p className="text-sm font-semibold text-slate-900">{log.itemName}</p>
                        <p className="text-xs text-slate-500 font-mono">{log.itemId}</p>
                        {log.condition && (
                          <span className="inline-block mt-1.5 rounded-md bg-slate-100 px-1.5 py-1 text-xs font-medium text-slate-700">
                            {log.condition}
                          </span>
                        )}
                      </div>
                    </div>

                    <div>
                      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500">Quantity Change</p>
                      <QuantityChange change={log.quantityChanged} />
                      <p className="mt-1.5 text-xs text-slate-600">{log.quantityBefore} → {log.quantityAfter}</p>
                    </div>

                    <div>
                      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500">Performed By</p>
                      <div className="space-y-0.5">
                        <p className="text-sm font-semibold text-slate-900">{log.userName}</p>
                        {log.userEmail && <p className="text-xs text-slate-500 truncate">{log.userEmail}</p>}
                      </div>
                    </div>

                    <div>
                      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500">Notes</p>
                      <div className="space-y-1">
                        {log.remarks ? (
                          <p className="text-sm text-slate-700">{log.remarks}</p>
                        ) : (
                          <p className="text-sm text-slate-400">—</p>
                        )}
                        {log.relatedId && (
                          <p className="text-xs text-slate-500 font-mono break-all">Ref: {log.relatedId.slice(0, 12)}...</p>
                        )}
                      </div>
                    </div>
                  </div>

                  {((log.stockBefore > 0 || log.reservedBefore > 0) || (log.stockAfter > 0 || log.reservedAfter > 0)) && (
                    <div className="mt-4 border-t border-slate-100 pt-4 grid gap-4 sm:grid-cols-2">
                      {(log.stockBefore > 0 || log.reservedBefore > 0) && (
                        <StockValueDisplay
                          label="Before"
                          stock={log.stockBefore}
                          reserved={log.reservedBefore}
                          available={Math.max(0, log.stockBefore - log.reservedBefore)}
                          condition={log.condition}
                        />
                      )}
                      {(log.stockAfter > 0 || log.reservedAfter > 0) && (
                        <StockValueDisplay
                          label="After"
                          stock={log.stockAfter}
                          reserved={log.reservedAfter}
                          available={Math.max(0, log.stockAfter - log.reservedAfter)}
                          condition={log.condition}
                        />
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  )
}
