'use client'

// Stock movement by piece: shelf aging and time-to-sell from piece records.
//
// Quantities say how much is in stock; piece records also say how long each
// piece has waited and how fast each condition sells - the second-hand
// questions a count cannot answer. Data from /api/inventory/units/insights.
//
// Layout: four figures across the top, then three panels - days on the shelf
// by category, days to sell by condition, and the pieces waiting longest.

import { useEffect, useState } from 'react'
import { apiFetch } from '@/lib/apiFetch'
import InfoTip from '@/components/shared/InfoTip'
import { GRADE_LABEL, GRADE_TONE, normalizeUnitGrade, type UnitGrade } from '@/lib/inventory/units'

interface Insights {
  summary: { onShelf: number; averageDaysOnShelf: number; staleCount: number; staleDays: number; soldWindowDays: number }
  aging: Array<{ category: string; count: number; averageDays: number; oldestDays: number; staleCount: number }>
  timeToSell: Array<{ grade: string; count: number; averageDays: number; medianDays: number }>
  slowest: Array<{ unitCode: string; itemName: string; category: string; grade: string; days: number }>
}

const days = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(1)} day${n === 1 ? '' : 's'}`

export default function UnitInsights() {
  const [data, setData] = useState<Insights | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    apiFetch('/api/inventory/units/insights')
      .then(async (res) => {
        const payload = await res.json()
        if (!res.ok) throw new Error(payload.error || 'Could not load stock movement.')
        if (!cancelled) setData(payload as Insights)
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load stock movement.') })
    return () => { cancelled = true }
  }, [])

  const stale = data?.summary.staleDays ?? 60
  const fastest = data?.timeToSell.length
    ? data.timeToSell.slice().sort((a, b) => a.medianDays - b.medianDays)[0]
    : null
  const soldTotal = data?.timeToSell.reduce((n, g) => n + g.count, 0) ?? 0
  // Bars share one scale per panel: the longest value fills the bar.
  const agingMax = Math.max(stale, ...(data?.aging.map((a) => a.averageDays) ?? [0]))
  const sellMax = Math.max(1, ...(data?.timeToSell.map((g) => g.medianDays) ?? [0]))

  const stats = data ? [
    { label: 'On the shelf', value: data.summary.onShelf.toLocaleString('en-PH'), hint: 'pieces waiting to sell', tone: 'text-slate-900' },
    { label: 'Average wait', value: days(data.summary.averageDaysOnShelf), hint: 'since each piece arrived', tone: 'text-slate-900' },
    { label: `Waiting ${stale}+ days`, value: data.summary.staleCount.toLocaleString('en-PH'), hint: 'pieces slow to move', tone: data.summary.staleCount > 0 ? 'text-amber-600' : 'text-slate-900' },
    {
      label: 'Sells fastest',
      value: fastest ? GRADE_LABEL[normalizeUnitGrade(fastest.grade)] : '—',
      hint: fastest ? `half sell within ${days(fastest.medianDays)}` : 'no pieces sold yet',
      tone: 'text-slate-900',
    },
  ] : []

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-1.5">
            <h3 className="text-sm font-semibold text-slate-900">Stock movement by piece</h3>
            <InfoTip label="About stock movement">
              Shows the shop as it is now, so it does not follow the date range above. Times to sell
              come from the last 180 days of sales; the other panels follow the selected range and filters.
            </InfoTip>
          </div>
          <p className="mt-0.5 text-xs text-slate-500">How long pieces wait on the shelf, and how fast each condition sells</p>
        </div>
        {data && soldTotal > 0 && (
          <span className="rounded-md bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500">
            Sales from the last {data.summary.soldWindowDays} days · {soldTotal.toLocaleString('en-PH')} pieces sold
          </span>
        )}
      </div>

      {error ? (
        <p className="py-10 text-center text-sm text-slate-500">{error}</p>
      ) : !data ? (
        <div className="mt-4 space-y-3">
          <div className="h-16 animate-pulse rounded-xl bg-slate-50" />
          <div className="h-48 animate-pulse rounded-xl bg-slate-50" />
        </div>
      ) : data.summary.onShelf === 0 && data.timeToSell.length === 0 ? (
        <p className="py-10 text-center text-sm text-slate-500">No pieces on the shelf or sold yet. This fills in as stock is added and sold.</p>
      ) : (
        <>
          {/* Four figures */}
          <div className="mt-4 grid grid-cols-2 divide-slate-200/80 overflow-hidden rounded-xl border border-slate-200/80 lg:grid-cols-4 lg:divide-x">
            {stats.map((s) => (
              <div key={s.label} className="px-4 py-3">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{s.label}</p>
                <p className={`mt-0.5 truncate text-xl font-bold leading-tight tabular-nums ${s.tone}`}>{s.value}</p>
                <p className="truncate text-[11px] text-slate-500">{s.hint}</p>
              </div>
            ))}
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            {/* Days on the shelf, by category */}
            <div className="rounded-xl border border-slate-200/80 p-3.5">
              <div className="mb-3 flex items-baseline justify-between gap-2">
                <h4 className="text-xs font-semibold text-slate-800">Days on the shelf, by category</h4>
                <span className="text-[10px] text-slate-500">average wait</span>
              </div>
              {data.aging.length === 0 ? (
                <p className="py-6 text-center text-xs text-slate-500">Nothing on the shelf.</p>
              ) : (
                <ul className="space-y-3">
                  {data.aging.map((a) => {
                    const slow = a.averageDays > stale
                    return (
                      <li key={a.category}>
                        <div className="flex items-baseline justify-between gap-2 text-xs">
                          <span className="truncate font-medium text-slate-800">{a.category}</span>
                          <span className={`shrink-0 tabular-nums ${slow ? 'font-semibold text-amber-700' : 'text-slate-700'}`}>{days(a.averageDays)}</span>
                        </div>
                        <div className="relative mt-1 h-1.5 rounded-full bg-slate-100">
                          <div className={`h-full rounded-full ${slow ? 'bg-amber-500' : 'bg-blue-600'}`} style={{ width: `${Math.max(3, (a.averageDays / agingMax) * 100)}%` }} />
                          {/* Where "slow to move" starts */}
                          <span aria-hidden className="absolute -top-0.5 h-2.5 w-px bg-slate-400" style={{ left: `${(stale / agingMax) * 100}%` }} title={`${stale} days`} />
                        </div>
                        <p className="mt-1 text-[11px] text-slate-500">
                          {a.count} piece{a.count === 1 ? '' : 's'} · oldest {days(a.oldestDays)}
                          {a.staleCount > 0 && <span className="text-amber-700"> · {a.staleCount} over {stale} days</span>}
                        </p>
                      </li>
                    )
                  })}
                </ul>
              )}
              <p className="mt-3 flex items-center gap-1.5 border-t border-slate-100 pt-2 text-[10px] text-slate-500">
                <span aria-hidden className="inline-block h-2.5 w-px bg-slate-400" /> marks {stale} days
              </p>
            </div>

            {/* Days to sell, by condition */}
            <div className="rounded-xl border border-slate-200/80 p-3.5">
              <div className="mb-3 flex items-baseline justify-between gap-2">
                <h4 className="text-xs font-semibold text-slate-800">Days to sell, by condition</h4>
                <span className="text-[10px] text-slate-500">half sell within</span>
              </div>
              {data.timeToSell.length === 0 ? (
                <p className="py-6 text-center text-xs text-slate-500">No pieces sold in the last {data.summary.soldWindowDays} days.</p>
              ) : (
                <ul className="space-y-3">
                  {data.timeToSell.map((g) => {
                    const grade = normalizeUnitGrade(g.grade) as UnitGrade
                    return (
                      <li key={g.grade}>
                        <div className="flex items-baseline justify-between gap-2 text-xs">
                          <span className="flex min-w-0 items-center gap-1.5 font-medium text-slate-800">
                            <span className={`h-2 w-2 shrink-0 rounded-full ${GRADE_TONE[grade].dot}`} />
                            <span className="truncate">{GRADE_LABEL[grade]}</span>
                          </span>
                          <span className="shrink-0 tabular-nums text-slate-700">{days(g.medianDays)}</span>
                        </div>
                        <div className="mt-1 h-1.5 rounded-full bg-slate-100">
                          <div className={`h-full rounded-full ${GRADE_TONE[grade].bar}`} style={{ width: `${Math.max(3, (g.medianDays / sellMax) * 100)}%` }} />
                        </div>
                        <p className="mt-1 text-[11px] text-slate-500">
                          {g.count.toLocaleString('en-PH')} sold · average {days(g.averageDays)}
                        </p>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>

            {/* Waiting longest */}
            <div className="rounded-xl border border-slate-200/80 p-3.5">
              <div className="mb-2 flex items-baseline justify-between gap-2">
                <h4 className="text-xs font-semibold text-slate-800">Waiting longest</h4>
                <span className="text-[10px] text-slate-500">on the shelf</span>
              </div>
              {data.slowest.length === 0 ? (
                <p className="py-6 text-center text-xs text-slate-500">Nothing on the shelf.</p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {data.slowest.map((s, i) => {
                    const grade = normalizeUnitGrade(s.grade) as UnitGrade
                    const slow = s.days > stale
                    return (
                      <li key={s.unitCode} className="flex items-center gap-2.5 py-2">
                        <span className="w-4 shrink-0 text-right text-[11px] tabular-nums text-slate-500">{i + 1}</span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs font-semibold text-slate-800" title={s.itemName}>{s.itemName}</p>
                          <p className="flex items-center gap-1.5 truncate text-[11px] text-slate-500">
                            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${GRADE_TONE[grade].dot}`} />
                            {GRADE_LABEL[grade]}
                            <span className="text-slate-300">·</span>
                            <span className="font-mono text-[10px] text-slate-500">#{s.unitCode}</span>
                          </p>
                        </div>
                        <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-semibold tabular-nums ${slow ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-600'}`}>
                          {s.days} {s.days === 1 ? 'day' : 'days'}
                        </span>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  )
}
