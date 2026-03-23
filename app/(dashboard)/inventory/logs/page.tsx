'use client'

import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import { collection, onSnapshot, orderBy, query } from 'firebase/firestore'
import ProtectedRoute from '@/components/ProtectedRoute'
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

const actionBadgeClassName = (value: ResolvedStockLogAction) => {
  switch (value) {
    case 'stock_increased':
    case 'item_added':
    case 'stock_transferred_in':
    case 'reservation_release':
      return 'bg-emerald-100 text-emerald-800'
    case 'stock_decreased':
    case 'sale_deduction':
    case 'reservation_deduction':
    case 'reservation_claim':
    case 'stock_transferred_out':
      return 'bg-amber-100 text-amber-800'
    case 'condition_changed':
    case 'item_edited':
      return 'bg-sky-100 text-sky-800'
    case 'unmapped_action':
      return 'bg-rose-100 text-rose-700'
    default:
      return 'bg-slate-100 text-slate-700'
  }
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

          <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Visible Logs</p>
              <p className="mt-1 text-2xl font-semibold text-slate-900">{summary.total}</p>
            </div>
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
              <p className="text-xs font-medium uppercase tracking-wide text-emerald-700">Stock Changes</p>
              <p className="mt-1 text-2xl font-semibold text-emerald-900">{summary.stockChanges}</p>
            </div>
            <div className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3">
              <p className="text-xs font-medium uppercase tracking-wide text-sky-700">Item Updates</p>
              <p className="mt-1 text-2xl font-semibold text-sky-900">{summary.itemUpdates}</p>
            </div>
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
              <p className="text-xs font-medium uppercase tracking-wide text-amber-700">Reservation / Sales</p>
              <p className="mt-1 text-2xl font-semibold text-amber-900">{summary.reservationAndSales}</p>
            </div>
          </div>

          {error ? <p className="mb-3 text-sm text-red-600">{error}</p> : null}
          {loading ? (
            <p className="text-sm text-slate-500">Loading stock logs...</p>
          ) : filteredLogs.length === 0 ? (
            <p className="text-sm text-slate-500">No stock logs found.</p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-200">
              <table className="min-w-full divide-y divide-slate-200 bg-white">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="px-3.5 py-2.5 text-left text-sm font-semibold text-slate-700">Date/Time</th>
                    <th className="px-3.5 py-2.5 text-left text-sm font-semibold text-slate-700">Action</th>
                    <th className="px-3.5 py-2.5 text-left text-sm font-semibold text-slate-700">Item</th>
                    <th className="px-3.5 py-2.5 text-left text-sm font-semibold text-slate-700">Previous Value</th>
                    <th className="px-3.5 py-2.5 text-left text-sm font-semibold text-slate-700">New Value</th>
                    <th className="px-3.5 py-2.5 text-left text-sm font-semibold text-slate-700">Quantity Change</th>
                    <th className="px-3.5 py-2.5 text-left text-sm font-semibold text-slate-700">Performed By</th>
                    <th className="px-3.5 py-2.5 text-left text-sm font-semibold text-slate-700">Note</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {filteredLogs.map((log) => (
                    <tr key={log.id} className="hover:bg-slate-50">
                      <td className="px-3.5 py-2.5 text-sm text-slate-700">{formatDate(log.createdAt)}</td>
                      <td className="px-3.5 py-2.5 text-sm">
                        <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${actionBadgeClassName(log.resolvedAction)}`}>
                          {getStockLogActionLabel(log.resolvedAction)}
                        </span>
                      </td>
                      <td className="px-3.5 py-2.5 text-sm text-slate-700">
                        <p className="font-medium text-slate-900">{log.itemName}</p>
                        <p className="text-xs text-slate-500">{log.itemId}</p>
                        <p className="mt-1 text-xs text-slate-500">{log.condition}</p>
                      </td>
                      <td className="px-3.5 py-2.5 text-sm text-slate-700">
                        <p>{log.previousValue || `Stock: ${log.stockBefore}, Reserved: ${log.reservedBefore}`}</p>
                      </td>
                      <td className="px-3.5 py-2.5 text-sm text-slate-700">
                        <p>{log.newValue || `Stock: ${log.stockAfter}, Reserved: ${log.reservedAfter}`}</p>
                      </td>
                      <td className="px-3.5 py-2.5 text-sm">
                        <span className={`font-semibold ${log.quantityChanged > 0 ? 'text-emerald-700' : log.quantityChanged < 0 ? 'text-amber-700' : 'text-slate-700'}`}>
                          {log.quantityChanged > 0 ? `+${log.quantityChanged}` : log.quantityChanged}
                        </span>
                      </td>
                      <td className="px-3.5 py-2.5 text-sm text-slate-700">
                        <p>{log.userName}</p>
                        <p className="text-xs text-slate-500">{log.userEmail || 'No email'}</p>
                      </td>
                      <td className="px-3.5 py-2.5 text-sm text-slate-700">
                        <p>{log.remarks || '-'}</p>
                        {log.relatedId ? <p className="mt-1 text-xs text-slate-500">Ref: {log.relatedId}</p> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </main>
  )
}
