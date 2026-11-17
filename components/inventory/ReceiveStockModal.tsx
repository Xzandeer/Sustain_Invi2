'use client'

// Add stock - a batch of pieces, each in its own condition.
//
// Three panels, left to right:
//   1. Batch   - the item, how many pieces arrived and their price.
//   2. Pieces  - one card per piece. They all start in the same condition;
//                select the ones that differ and set their condition, a note
//                or an exact price from the bar that appears.
//   3. Check   - the batch by condition with its value, then save.
// Every piece sells at the batch price, whatever its condition, unless a piece is
// given an exact price. Saving creates one record per piece
// (lib/inventory/units.ts) and can print their labels.
//
// Typing the name of an item already in the shop adds the batch to that item
// and takes its category and price. Suggestions appear only while typing, and
// only the closest few, so the list never has to be scrolled through.
//
// Used by Inventory (Add stock, and a row's "Add more stock") and the
// dashboard's Add stock quick action.

import { useEffect, useMemo, useState, useRef } from 'react'
import { useWindowFocus } from '@/lib/client/useWindowFocus'
import { useConfirm } from '@/components/shared/ConfirmDialog'
import { Loader2, X } from 'lucide-react'
import { toast } from 'sonner'
import { apiFetch } from '@/lib/apiFetch'
import { INPUT_LIMITS, MAX_CONDITION_NOTES, MAX_STOCK, clampIntegerInput, clampPriceInput } from '@/lib/constants/limits'
import { blockDecimalKeys } from '@/lib/client/blockDecimalKeys'
import {
  DEFAULT_GRADE_PRICING, GRADE_LABEL, GRADE_MEANING, GRADE_TONE, UNIT_GRADES, gradePrice,
  type GradePricing, type TrackingMode, type UnitGrade,
} from '@/lib/inventory/units'
import { openUnitLabelsPrintWindow } from '@/lib/transactions/labelPrint'

export interface ReceiveTarget {
  id: string
  name: string
  categoryId: string
  category: string
  price: number
  trackingMode?: TrackingMode
}

interface Piece { grade: UnitGrade; note: string; price: number | null; selected: boolean }

interface ReceiveStockModalProps {
  isOpen: boolean
  onClose: () => void
  categories: Array<{ id: string; name: string }>
  /** Existing items, to recognise one by name. */
  items: ReceiveTarget[]
  /** "Add more stock" on a row: start with this item. */
  preset?: ReceiveTarget | null
  onReceived?: () => void
}

const peso = (n: number) => `₱${Math.round(n).toLocaleString('en-PH')}`
const norm = (v: string) => v.trim().replace(/\s+/g, ' ').toLowerCase()
const MAX_PIECES = 200
/** Suggestions shown under the name box: only the closest few. */
const MAX_SUGGESTIONS = 5

export default function ReceiveStockModal({ isOpen, onClose, categories, items, preset, onReceived }: ReceiveStockModalProps) {
  const [name, setName] = useState('')
  const [nameFocused, setNameFocused] = useState(false)
  const [categoryId, setCategoryId] = useState('')
  const [count, setCount] = useState('1')
  const [basePrice, setBasePrice] = useState('')
  const [minStock, setMinStock] = useState('')
  const [defaultGrade, setDefaultGrade] = useState<UnitGrade>('Good')
  const [pieces, setPieces] = useState<Piece[]>([])
  const [bulkNote, setBulkNote] = useState('')
  const [bulkPrice, setBulkPrice] = useState('')
  const [pricing, setPricing] = useState<GradePricing>(DEFAULT_GRADE_PRICING)
  const [lastClicked, setLastClicked] = useState<number | null>(null)
  // True right after the selection was given a condition, note or price.
  const [justApplied, setJustApplied] = useState(false)
  const [saving, setSaving] = useState(false)

  // Start fresh each time it opens.
  useEffect(() => {
    if (!isOpen) return
    setName(preset?.name ?? '')
    setCategoryId(preset?.categoryId ?? categories[0]?.id ?? '')
    setCount('1')
    setBasePrice(preset ? String(preset.price) : '')
    setMinStock('')
    setDefaultGrade('Good')
    // One card for the one piece above. (An empty list stayed empty when the
    // count was already 1, since the effect that builds cards only runs on a change.)
    setPieces([{ grade: 'Good', note: '', price: null, selected: false }])
    setBulkNote('')
    setBulkPrice('')
    setLastClicked(null)
    setJustApplied(false)
    apiFetch('/api/settings')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.gradePricing) setPricing(d.gradePricing as GradePricing) })
      .catch(() => {})
  }, [isOpen, preset, categories])

  // The item this batch belongs to, if it is already in the shop: the one
  // with this name, in the chosen category when two categories share a name.
  const existing = useMemo(() => {
    if (preset) return preset
    const sameName = items.filter((i) => norm(i.name) === norm(name))
    return sameName.find((i) => i.categoryId === categoryId) ?? (sameName.length === 1 ? sameName[0] : null)
  }, [preset, items, categoryId, name])

  // Recognised an existing item: take its category and price.
  const existingId = existing?.id
  useEffect(() => {
    if (!existing || preset) return
    setCategoryId(existing.categoryId)
    setBasePrice(String(existing.price))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existingId])

  // A few close matches while typing - never the whole inventory.
  const suggestions = useMemo(() => {
    const q = norm(name)
    if (preset || q.length < 2 || existing) return []
    const starts = items.filter((i) => norm(i.name).startsWith(q))
    const contains = items.filter((i) => !norm(i.name).startsWith(q) && norm(i.name).includes(q))
    return [...starts, ...contains].slice(0, MAX_SUGGESTIONS)
  }, [items, name, preset, existing])

  // An existing counted item stays counted; everything else is per piece.
  const unitMode = !existing || existing.trackingMode === 'unit'

  // Keep one card per piece, preserving what was already marked.
  const n = Math.max(0, Math.min(MAX_PIECES, Math.floor(Number(count) || 0)))
  useEffect(() => {
    if (!unitMode) return
    setPieces((cur) => Array.from({ length: n }, (_, i) => cur[i] ?? { grade: defaultGrade, note: '', price: null, selected: false }))
  }, [n, unitMode, defaultGrade])

  // Closing with unsaved work (Esc or ✕) asks first, in the app's own window.
  const { confirm, confirmDialog } = useConfirm()
  const requestClose = async () => {
    if (saving) return
    if ((name.trim() !== '' && !preset) || basePrice !== '') {
      const ok = await confirm({ title: 'Discard this stock?', message: 'What you entered for this batch will be cleared.', confirmLabel: 'Discard', cancelLabel: 'Keep editing', tone: 'danger' })
      if (!ok) return
    }
    onClose()
  }
  const requestCloseRef = useRef(requestClose)
  requestCloseRef.current = requestClose

  // Escape closes, except while saving.
  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !saving) void requestCloseRef.current() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, saving])

  // Focus moves into the window and Tab stays inside it.
  const panelRef = useRef<HTMLDivElement>(null)
  useWindowFocus(panelRef, isOpen)

  if (!isOpen) return null

  const typedBase = Number(basePrice) || 0
  // Every piece priced on its own: the New price is worked out from them (a
  // Good piece at ₱700 means ₱1,000 New at 70%), so it need not be typed.
  const allPriced = unitMode && pieces.length > 0 && pieces.every((p) => p.price !== null)
  const derivedBase = allPriced
    ? Math.max(...pieces.map((p) => Math.round(((p.price ?? 0) * 100) / Math.max(1, pricing[p.grade]))))
    : 0
  const base = typedBase > 0 ? typedBase : derivedBase
  const priceOf = (p: Piece) => p.price ?? gradePrice(base, p.grade, pricing)
  const selectedCount = pieces.filter((p) => p.selected).length
  const total = unitMode ? pieces.reduce((s, p) => s + priceOf(p), 0) : n * gradePrice(base, defaultGrade, pricing)
  const groups = UNIT_GRADES
    .map((g) => ({ g, list: unitMode ? pieces.filter((p) => p.grade === g) : (g === defaultGrade ? Array(n).fill(null) : []) }))
    .filter((x) => x.list.length > 0)

  // Changing the starting condition moves every piece still on it (and not
  // marked otherwise) to the new one.
  const changeDefaultGrade = (g: UnitGrade) => {
    setPieces((cur) => cur.map((p) => (p.grade === defaultGrade && !p.note && p.price === null ? { ...p, grade: g } : p)))
    setDefaultGrade(g)
  }
  const clickPiece = (i: number, shift: boolean) => {
    const fresh = justApplied
    setJustApplied(false)
    setPieces((cur) => {
      // The last selection was just given a condition, note or price: clicking
      // another piece starts the next batch instead of adding to that one.
      const next = cur.map((p) => ({ ...p, selected: fresh && !shift && !cur[i].selected ? false : p.selected }))
      if (shift && lastClicked !== null) {
        const [a, b] = [Math.min(lastClicked, i), Math.max(lastClicked, i)]
        for (let k = a; k <= b; k++) next[k].selected = true
      } else {
        next[i].selected = !next[i].selected
      }
      return next
    })
    setLastClicked(i)
  }
  const setSelectedGrade = (g: UnitGrade) => {
    setPieces((cur) => cur.map((p) => (p.selected ? { ...p, grade: g, price: null } : p)))
    setJustApplied(true)
  }
  const applyNote = () => {
    setPieces((cur) => cur.map((p) => (p.selected ? { ...p, note: bulkNote.trim().slice(0, MAX_CONDITION_NOTES) } : p)))
    setBulkNote('')
    setJustApplied(true)
  }
  // An exact price for the selected pieces; empty puts them back on their condition's price.
  const applyPrice = () => {
    const v = bulkPrice.trim() === '' ? null : Math.max(1, Math.round(Number(bulkPrice) || 0))
    setPieces((cur) => cur.map((p) => (p.selected ? { ...p, price: v } : p)))
    setBulkPrice('')
    setJustApplied(true)
  }
  const clearSelection = () => setPieces((c) => c.map((p) => ({ ...p, selected: false })))

  const save = async (print: boolean) => {
    if (!existing && (!name.trim() || !categoryId)) { toast.error('Enter the item name and category.'); return }
    if (n <= 0) { toast.error('Enter how many pieces arrived.'); return }
    if (n > MAX_STOCK) { toast.error(`Add at most ${MAX_STOCK} pieces at a time.`); return }
    if (base <= 0) { toast.error('Enter the price, or give every piece its own price.'); return }
    setSaving(true)
    try {
      const res = await apiFetch('/api/inventory/receive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(existing ? { itemId: existing.id } : {}),
          name: name.trim(),
          categoryId,
          basePrice: base,
          minStock: minStock ? Number(minStock) : undefined,
          trackingMode: unitMode ? 'unit' : 'quantity',
          ...(unitMode
            ? { pieces: pieces.map((p) => ({ grade: p.grade, conditionNotes: p.note, priceOverride: p.price })) }
            : { quantity: n, grade: defaultGrade }),
        }),
      })
      const payload = (await res.json()) as { error?: string; units?: Array<{ unitCode: string; grade: string; price: number }> }
      if (!res.ok) throw new Error(payload.error || 'Could not add this stock.')
      toast.success(`${n} piece${n === 1 ? '' : 's'} added${existing ? ` to ${existing.name}` : ''}.`)
      if (print && payload.units?.length) {
        const cat = categories.find((c) => c.id === categoryId)?.name ?? existing?.category
        openUnitLabelsPrintWindow(
          { name: existing?.name ?? name.trim(), price: base, condition: '', categoryName: cat },
          payload.units.map((u) => ({ unitCode: u.unitCode, grade: u.grade, price: u.price })),
        )
      }
      onReceived?.()
      onClose()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not add this stock.')
    } finally {
      setSaving(false)
    }
  }

  const field = 'mt-1 w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-[13px] text-slate-900 outline-none placeholder:text-slate-400 focus:border-blue-500 disabled:bg-slate-50 disabled:text-slate-500'
  const label = 'text-[11px] font-medium text-slate-600'
  const step = 'flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-600 text-[11px] font-bold text-white'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 md:pl-[calc(13rem+1rem)]" role="dialog" aria-modal="true" aria-labelledby="add-stock-title">
      {confirmDialog}
      <div ref={panelRef} className="flex max-h-[calc(100vh-2rem)] w-full flex-col overflow-hidden rounded-2xl bg-[#F1F5FC] shadow-2xl lg:h-[calc(100vh-2rem)]">
        <div className="flex items-center justify-between border-b border-slate-200 bg-white px-5 py-3">
          <div>
            <h2 id="add-stock-title" className="text-lg font-bold tracking-tight text-slate-900">Add stock</h2>
            <p className="text-xs text-slate-500">Enter the batch once, then mark only the pieces that differ.</p>
          </div>
          <button type="button" onClick={() => void requestClose()} disabled={saving} aria-label="Close" className="rounded-lg p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-40"><X className="h-5 w-5" /></button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto p-3 lg:grid-cols-12 lg:grid-rows-[minmax(0,1fr)]">
          {/* 1. Batch */}
          <section className="rounded-xl border border-slate-200/80 bg-white p-4 lg:col-span-3 lg:overflow-y-auto">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-800"><span className={step}>1</span>Batch</h3>
            <div className="mt-3 space-y-3">
              <div className="relative">
                <label className="block">
                  <span className={label}>Item</span>
                  <input maxLength={INPUT_LIMITS.name} value={name} onChange={(e) => setName(e.target.value)} disabled={!!preset || saving} autoComplete="off" autoFocus={!preset}
                    onFocus={() => setNameFocused(true)} onBlur={() => setTimeout(() => setNameFocused(false), 150)}
                    placeholder="e.g. Ceramic Dinner Plate" className={field} />
                </label>
                {/* The closest few items already in the shop, only while typing. */}
                {nameFocused && suggestions.length > 0 && (
                  <ul className="absolute inset-x-0 z-10 mt-1 overflow-hidden rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
                    <li className="px-2.5 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Already in the shop</li>
                    {suggestions.map((i) => (
                      <li key={i.id}>
                        <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => { setName(i.name); setCategoryId(i.categoryId); setNameFocused(false) }}
                          className="flex w-full items-baseline justify-between gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-blue-50">
                          <span className="truncate font-medium text-slate-800">{i.name}</span>
                          <span className="shrink-0 text-[11px] text-slate-500">{i.category}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {name.trim() && (
                  <span className={`mt-1.5 inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] font-medium ${existing ? 'bg-blue-50 text-blue-600' : 'bg-slate-100 text-slate-600'}`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${existing ? 'bg-blue-600' : 'bg-slate-400'}`} />
                    {existing ? 'Already in the shop: adding to it' : 'New item'}
                  </span>
                )}
              </div>
              <label className="block">
                <span className={label}>Category</span>
                <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} disabled={!!existing || saving} className={field}>
                  {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className={label}>Pieces</span>
                  <input type="number" min={1} max={MAX_PIECES} value={count} onKeyDown={blockDecimalKeys} onChange={(e) => setCount(clampIntegerInput(e.target.value, count, MAX_PIECES))} disabled={saving} className={`${field} tabular-nums`} />
                </label>
                <label className="block">
                  <span className={label}>Price{allPriced && <span className="font-normal text-slate-500"> (optional)</span>}</span>
                  <input maxLength={INPUT_LIMITS.money} inputMode="decimal" value={basePrice} onChange={(e) => setBasePrice(clampPriceInput(e.target.value, basePrice))} disabled={saving}
                    placeholder={allPriced && derivedBase > 0 ? `₱${derivedBase.toLocaleString('en-PH')}` : '₱0'} className={`${field} tabular-nums`} />
                </label>
              </div>
              {!existing && (
                <label className="block">
                  <span className={label}>Minimum stock <span className="font-normal text-slate-500">(optional)</span></span>
                  <input type="number" min={0} max={MAX_STOCK} value={minStock} onKeyDown={blockDecimalKeys} onChange={(e) => setMinStock(clampIntegerInput(e.target.value, minStock))} disabled={saving} placeholder="0" className={`${field} tabular-nums`} />
                </label>
              )}
            </div>
          </section>

          {/* 2. Pieces */}
          <section className="flex min-h-[320px] flex-col rounded-xl border border-slate-200/80 bg-white lg:col-span-6 lg:min-h-0">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
              <div>
                <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-800"><span className={step}>2</span>{unitMode ? 'Pieces' : 'Condition'}</h3>
                <p className="mt-0.5 text-[11px] text-slate-500">
                  {unitMode ? 'Click the pieces that differ, then set their condition, note or price. Your next click starts a new group.' : 'Counted stock has one condition for the whole batch.'}
                </p>
              </div>
              <label className="flex items-center gap-2 text-xs text-slate-600">
                {unitMode ? 'All start as' : 'Condition'}
                <select value={defaultGrade} onChange={(e) => changeDefaultGrade(e.target.value as UnitGrade)} disabled={saving}
                  className="h-8 rounded-lg border border-slate-200 bg-white px-2 text-xs font-semibold text-slate-800 outline-none focus:border-blue-500">
                  {UNIT_GRADES.map((g) => <option key={g} value={g}>{GRADE_LABEL[g]}</option>)}
                </select>
              </label>
            </div>

            {/* What to do with the selected pieces. */}
            {unitMode && selectedCount > 0 && (
              <div className="space-y-2 border-b border-blue-100 bg-blue-50/70 px-4 py-2.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="mr-1 text-xs font-semibold text-blue-700">{selectedCount} selected</span>
                  {UNIT_GRADES.map((g) => (
                    <button key={g} type="button" onClick={() => setSelectedGrade(g)} title={`${GRADE_LABEL[g]}: ${GRADE_MEANING[g]}`}
                      className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2 text-[11px] font-semibold text-slate-700 transition hover:border-blue-300 hover:bg-blue-50">
                      <span className={`h-1.5 w-1.5 rounded-full ${GRADE_TONE[g].dot}`} />{g}
                    </button>
                  ))}
                  <button type="button" onClick={clearSelection} className="ml-auto text-[11px] font-medium text-blue-600 hover:underline">Clear selection</button>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <input value={bulkNote} onChange={(e) => setBulkNote(e.target.value)} maxLength={MAX_CONDITION_NOTES}
                    onKeyDown={(e) => { if (e.key === 'Enter') applyNote() }}
                    placeholder="Note, e.g. scratch on rim" className="h-7 min-w-[160px] flex-1 rounded-lg border border-slate-200 bg-white px-2.5 text-xs outline-none focus:border-blue-500" />
                  <button type="button" onClick={applyNote} className="h-7 rounded-lg border border-slate-200 bg-white px-2.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-50">Set note</button>
                  <input maxLength={INPUT_LIMITS.money} value={bulkPrice} inputMode="decimal" onChange={(e) => setBulkPrice(clampPriceInput(e.target.value, bulkPrice))}
                    onKeyDown={(e) => { if (e.key === 'Enter') applyPrice() }}
                    placeholder="Exact price" className="h-7 w-28 rounded-lg border border-slate-200 bg-white px-2.5 text-xs tabular-nums outline-none focus:border-blue-500" />
                  <button type="button" onClick={applyPrice} title="Empty puts the pieces back on their condition's price"
                    className="h-7 rounded-lg border border-slate-200 bg-white px-2.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-50">Set price</button>
                </div>
              </div>
            )}

            {unitMode ? (
              <div className="grid min-h-0 flex-1 grid-cols-2 content-start gap-2 overflow-y-auto p-4 sm:grid-cols-3 xl:grid-cols-5">
                {pieces.map((p, i) => (
                  <button key={i} type="button" onClick={(e) => clickPiece(i, e.shiftKey)} aria-pressed={p.selected}
                    className={`rounded-lg border p-2.5 text-left transition-colors ${p.selected ? 'border-blue-600 bg-blue-50 ring-1 ring-blue-600' : 'border-slate-200 hover:border-slate-300'}`}>
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-[11px] font-semibold tabular-nums text-slate-500">#{i + 1}</span>
                      <span title={`${GRADE_LABEL[p.grade]}: ${GRADE_MEANING[p.grade]}`} className="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-700">
                        <span className={`h-1.5 w-1.5 rounded-full ${GRADE_TONE[p.grade].dot}`} />{p.grade}
                      </span>
                    </div>
                    <p className={`mt-1.5 text-base font-bold tabular-nums ${p.price !== null ? 'text-blue-600' : 'text-slate-900'}`}>
                      {base > 0 || p.price !== null ? peso(priceOf(p)) : '—'}
                    </p>
                    <p className={`mt-0.5 truncate text-[11px] ${p.note ? 'text-slate-600' : 'text-slate-300'}`}>
                      {p.price !== null ? 'own price' + (p.note ? ' · ' + p.note : '') : p.note || 'no notes'}
                    </p>
                  </button>
                ))}
                {pieces.length === 0 && <p className="col-span-full py-10 text-center text-xs text-slate-500">Enter how many pieces arrived.</p>}
              </div>
            ) : (
              <p className="p-6 text-sm text-slate-600">
                {n} piece{n === 1 ? '' : 's'} counted as <span className="font-semibold">{GRADE_LABEL[defaultGrade]}</span>, at {peso(gradePrice(base, defaultGrade, pricing))} each.
              </p>
            )}
            {/* What each condition means, so everyone grades alike. */}
            <dl className="mt-auto grid grid-cols-1 gap-x-4 gap-y-1 border-t border-slate-100 px-4 py-2.5 text-[11px] sm:grid-cols-2">
              {UNIT_GRADES.map((g) => (
                <div key={g} className="flex gap-1.5">
                  <dt className="flex shrink-0 items-center gap-1 font-semibold text-slate-700"><span className={`h-1.5 w-1.5 rounded-full ${GRADE_TONE[g].dot}`} />{GRADE_LABEL[g]}</dt>
                  <dd className="truncate text-slate-500" title={GRADE_MEANING[g]}>{GRADE_MEANING[g]}</dd>
                </div>
              ))}
            </dl>
            {unitMode && pieces.length > 1 && (
              <div className="flex items-center justify-between border-t border-slate-100 px-4 py-2 text-[11px] text-slate-500">
                <span>Shift-click selects a range.</span>
                <button type="button" onClick={() => setPieces((c) => c.map((p) => ({ ...p, selected: true })))} className="font-medium text-blue-600 hover:underline">Select all {pieces.length}</button>
              </div>
            )}
          </section>

          {/* 3. Check and save */}
          <section className="flex flex-col rounded-xl border border-slate-200/80 bg-white p-4 lg:col-span-3 lg:overflow-y-auto">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-800"><span className={step}>3</span>Check and save</h3>
            <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2.5">
              <p className="truncate text-[13px] font-semibold text-slate-900">{(existing?.name ?? name.trim()) || 'Item not named yet'}</p>
              <p className="text-[11px] text-slate-500">
                {categories.find((c) => c.id === categoryId)?.name ?? existing?.category ?? 'No category'}
                <span className="mx-1 text-slate-300">·</span>{existing ? 'adding to existing item' : 'new item'}
              </p>
            </div>
            <div className="mt-2 space-y-1.5">
              {groups.map(({ g, list }) => (
                <div key={g} className="flex items-center justify-between rounded-lg border border-slate-200 px-2.5 py-2 text-xs">
                  <span className="flex items-center gap-1.5 text-slate-700"><span className={`h-2 w-2 rounded-full ${GRADE_TONE[g].dot}`} /><span className="font-semibold tabular-nums text-slate-900">{list.length}</span> {GRADE_LABEL[g]}</span>
                  <span className="font-semibold tabular-nums text-slate-900">
                    {base > 0 || (unitMode && (list as Piece[]).some((p) => p.price !== null))
                      ? peso(unitMode ? (list as Piece[]).reduce((s, p) => s + priceOf(p), 0) : list.length * gradePrice(base, g, pricing))
                      : '—'}
                  </span>
                </div>
              ))}
              {groups.length === 0 && <p className="py-3 text-center text-xs text-slate-500">No pieces yet.</p>}
            </div>
            <div className="mt-3 flex items-baseline justify-between border-t border-slate-100 pt-3">
              <span className="text-xs text-slate-500">{n} piece{n === 1 ? '' : 's'} · batch value</span>
              <span className="text-xl font-bold tabular-nums text-slate-900">{base > 0 || pieces.some((p) => p.price !== null) ? peso(total) : '—'}</span>
            </div>
            <div className="mt-auto space-y-2 pt-4">
              <button type="button" onClick={() => save(unitMode)} disabled={saving || n <= 0}
                className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-blue-600 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50">
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                {unitMode ? `Save ${n} piece${n === 1 ? '' : 's'} and print labels` : `Save ${n} piece${n === 1 ? '' : 's'}`}
              </button>
              {unitMode && (
                <button type="button" onClick={() => save(false)} disabled={saving || n <= 0}
                  className="h-9 w-full rounded-xl border border-slate-200 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                  Save without printing
                </button>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
