'use client'

// The pieces of one unit-tracked item (lib/inventory/units.ts).
//
// Opened from the Units button on an Inventory row. Shows every physical piece
// with its code, grade, notes, own price and where it is (on the shelf,
// reserved, sold, written off), lets a piece still in the shop be re-graded or
// given its own price, and prints one label per piece.

import { INPUT_LIMITS } from '@/lib/constants/limits'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, Printer, X } from 'lucide-react'
import { toast } from 'sonner'
import { apiFetch } from '@/lib/apiFetch'
import { auth } from '@/lib/firebase'
import { MAX_CONDITION_NOTES, clampPriceInput } from '@/lib/constants/limits'
import {
  DEFAULT_GRADE_PRICING, GRADE_LABEL, GRADE_MEANING, GRADE_TONE, UNIT_GRADES, UNIT_STATUS_LABEL, gradePrice,
  type GradePricing, type UnitGrade, type UnitStatus,
} from '@/lib/inventory/units'
import { openUnitLabelsPrintWindow } from '@/lib/transactions/labelPrint'

export interface UnitRow {
  id: string
  unitCode: string
  grade: UnitGrade
  conditionNotes: string
  priceOverride: number | null
  status: UnitStatus
  receivedAt: string
  soldAt: string | null
}

interface UnitsPanelProps {
  product: { id: string; name: string; condition: string; category: string; price: number }
  canEdit: boolean
  onClose: () => void
  /** Shown under its Inventory row rather than as a window. */
  inline?: boolean
}

const STATUS_TONE: Record<UnitStatus, string> = {
  in_stock: 'bg-slate-100 text-slate-700',
  reserved: 'bg-blue-50 text-blue-600',
  sold: 'bg-slate-100 text-slate-600',
  written_off: 'bg-red-50 text-red-600',
}

const TABS: Array<{ id: 'shop' | 'sold' | 'written_off'; label: string; statuses: UnitStatus[] }> = [
  { id: 'shop', label: 'In the shop', statuses: ['in_stock', 'reserved'] },
  { id: 'sold', label: 'Sold', statuses: ['sold'] },
  { id: 'written_off', label: 'Written off', statuses: ['written_off'] },
]

const peso = (n: number) => `₱${n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const shortDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'
const daysSince = (iso: string) => Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000))

export default function UnitsPanel({ product, canEdit, onClose, inline = false }: UnitsPanelProps) {
  const [pricing, setPricing] = useState<GradePricing>(DEFAULT_GRADE_PRICING)
  useEffect(() => {
    apiFetch('/api/settings').then((r) => (r.ok ? r.json() : null)).then((d) => { if (d?.gradePricing) setPricing(d.gradePricing) }).catch(() => {})
  }, [])
  const [units, setUnits] = useState<UnitRow[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'shop' | 'sold' | 'written_off'>('shop')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<{ id: string; grade: UnitGrade; notes: string; price: string } | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await apiFetch(`/api/inventory/${product.id}/units`)
      const payload = (await res.json()) as { data?: UnitRow[]; error?: string }
      if (!res.ok) throw new Error(payload.error || 'Could not load units.')
      setUnits(payload.data ?? [])
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not load units.')
    } finally {
      setLoading(false)
    }
  }, [product.id])

  useEffect(() => { load() }, [load])

  // Escape closes, as it does any overlay.
  useEffect(() => {
    if (inline) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !editing) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, editing, inline])

  const counts = useMemo(() => Object.fromEntries(TABS.map((t) => [t.id, units.filter((u) => t.statuses.includes(u.status)).length])), [units])
  const shown = useMemo(() => units.filter((u) => TABS.find((t) => t.id === tab)!.statuses.includes(u.status)), [units, tab])
  const printable = shown.filter((u) => u.status === 'in_stock' || u.status === 'reserved')

  const printLabels = (rows: UnitRow[]) => {
    if (rows.length === 0) { toast.error('Select the pieces to print labels for.'); return }
    openUnitLabelsPrintWindow(
      { name: product.name, price: product.price, condition: product.condition, categoryName: product.category },
      rows.map((u) => ({ unitCode: u.unitCode, grade: u.grade, price: u.priceOverride ?? gradePrice(product.price, u.grade, pricing) })),
    )
  }

  const saveEdit = async () => {
    if (!editing) return
    setSaving(true)
    try {
      const res = await apiFetch(`/api/inventory/units/${editing.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grade: editing.grade,
          conditionNotes: editing.notes,
          priceOverride: editing.price.trim() === '' ? null : Number(editing.price),
          processedBy: {
            uid: auth.currentUser?.uid ?? '',
            email: auth.currentUser?.email ?? '',
            name: auth.currentUser?.displayName ?? auth.currentUser?.email ?? '',
          },
        }),
      })
      const payload = (await res.json()) as { error?: string }
      if (!res.ok) throw new Error(payload.error || 'Could not save this piece.')
      toast.success('Piece updated.')
      setEditing(null)
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save this piece.')
    } finally {
      setSaving(false)
    }
  }

  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })

  const body = (
      <div className={inline
        ? 'flex max-h-[420px] w-full flex-col overflow-hidden rounded-lg border border-slate-200 bg-white'
        : 'flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl'}>
        {/* Under an Inventory row the row itself is the title and the way to close. */}
        {!inline && (
          <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
            <div className="min-w-0">
              <h2 className="truncate text-base font-semibold text-slate-900">{product.name}</h2>
              <p className="text-xs text-slate-500">{product.category} · {peso(product.price)}</p>
            </div>
            <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-700">
              <X className="h-5 w-5" />
            </button>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-2.5">
          <div className="flex gap-1 rounded-lg bg-slate-100 p-0.5 text-xs font-semibold">
            {TABS.map((t) => (
              <button key={t.id} type="button" onClick={() => { setTab(t.id); setSelected(new Set()) }}
                className={`rounded-md px-2.5 py-1 ${tab === t.id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>
                {t.label} <span className="tabular-nums text-slate-500">{counts[t.id] ?? 0}</span>
              </button>
            ))}
          </div>
          {tab === 'shop' && (
            // One button: the ticked pieces if any are ticked, otherwise all of them.
            <button type="button" disabled={printable.length === 0}
              onClick={() => { const picked = printable.filter((u) => selected.has(u.id)); printLabels(picked.length ? picked : printable) }}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40">
              <Printer className="h-3.5 w-3.5" />
              {(() => { const k = printable.filter((u) => selected.has(u.id)).length; return k > 0 ? `Print ${k} label${k === 1 ? '' : 's'}` : `Print all ${printable.length} labels` })()}
            </button>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading pieces…</div>
          ) : shown.length === 0 ? (
            <p className="py-16 text-center text-sm text-slate-500">No pieces here.</p>
          ) : (
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-slate-50 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  {tab === 'shop' && <th className="w-8 px-3 py-2" />}
                  <th className="px-3 py-2 text-left">Code</th>
                  <th className="px-3 py-2 text-left">Grade</th>
                  <th className="px-3 py-2 text-left">Notes</th>
                  <th className="px-3 py-2 text-right">Price</th>
                  <th className="px-3 py-2 text-left">Status</th>
                  <th className="px-3 py-2 text-left">{tab === 'sold' ? 'Sold' : 'In shop'}</th>
                  {canEdit && tab === 'shop' && <th className="px-3 py-2" />}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {shown.map((u) => {
                  const isEditing = editing?.id === u.id
                  return (
                    <tr key={u.id} className="align-top">
                      {tab === 'shop' && (
                        <td className="px-3 py-2">
                          <input type="checkbox" checked={selected.has(u.id)} onChange={() => toggle(u.id)} aria-label={`Select piece ${u.unitCode}`} className="h-3.5 w-3.5 accent-blue-600" />
                        </td>
                      )}
                      <td className="px-3 py-2 font-mono text-slate-700">{u.unitCode}</td>
                      <td className="px-3 py-2">
                        {isEditing ? (
                          <select value={editing.grade} onChange={(e) => setEditing({ ...editing, grade: e.target.value as UnitGrade })}
                            className="rounded-md border border-slate-300 px-1.5 py-1 text-xs">
                            {UNIT_GRADES.map((g) => <option key={g} value={g}>{GRADE_LABEL[g]}</option>)}
                          </select>
                        ) : <span title={`${GRADE_LABEL[u.grade]}: ${GRADE_MEANING[u.grade]}`} className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ring-1 ring-inset ${GRADE_TONE[u.grade].chip}`}>{u.grade}</span>}
                      </td>
                      <td className="max-w-[220px] px-3 py-2 text-slate-600">
                        {isEditing ? (
                          <input value={editing.notes} maxLength={MAX_CONDITION_NOTES} onChange={(e) => setEditing({ ...editing, notes: e.target.value })}
                            placeholder="e.g. scratch on lid" className="w-full rounded-md border border-slate-300 px-1.5 py-1 text-xs" />
                        ) : <span className="line-clamp-2">{u.conditionNotes || <span className="text-slate-300">—</span>}</span>}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {isEditing ? (
                          <input maxLength={INPUT_LIMITS.money} value={editing.price} inputMode="decimal" placeholder={String(gradePrice(product.price, editing.grade, pricing))}
                            onChange={(e) => setEditing({ ...editing, price: clampPriceInput(e.target.value, editing.price) })}
                            className="w-24 rounded-md border border-slate-300 px-1.5 py-1 text-right text-xs" />
                        ) : u.priceOverride !== null
                          ? <span className="font-semibold text-blue-700" title="This piece's own price">{peso(u.priceOverride)}</span>
                          : <span className="text-slate-500">{peso(gradePrice(product.price, u.grade, pricing))}</span>}
                      </td>
                      <td className="px-3 py-2">
                        <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-semibold ${STATUS_TONE[u.status]}`}>{UNIT_STATUS_LABEL[u.status]}</span>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-slate-500" title={`Arrived ${shortDate(u.receivedAt)}`}>
                        {tab === 'sold' ? shortDate(u.soldAt) : u.receivedAt ? `${daysSince(u.receivedAt)} days` : '—'}
                      </td>
                      {canEdit && tab === 'shop' && (
                        <td className="whitespace-nowrap px-3 py-2 text-right">
                          {isEditing ? (
                            <span className="inline-flex gap-1">
                              <button type="button" onClick={() => setEditing(null)} className="rounded-md border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-600">Cancel</button>
                              <button type="button" onClick={saveEdit} disabled={saving} className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-2 py-1 text-[11px] font-semibold text-white disabled:opacity-60">
                                {saving && <Loader2 className="h-3 w-3 animate-spin" />} Save
                              </button>
                            </span>
                          ) : (
                            <button type="button"
                              onClick={() => setEditing({ id: u.id, grade: u.grade, notes: u.conditionNotes, price: u.priceOverride !== null ? String(u.priceOverride) : '' })}
                              className="rounded-md border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50">
                              Edit
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        <p className="border-t border-slate-100 px-5 py-2.5 text-[11px] text-slate-500">
          Prices follow each piece&apos;s condition. Pieces sell oldest first; a piece with its own price sells at that price, from its condition&apos;s button or by scanning its label.
        </p>
      </div>
  )

  if (inline) return body
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" role="dialog" aria-modal="true" aria-label={`Units of ${product.name}`}>
      {body}
    </div>
  )
}
