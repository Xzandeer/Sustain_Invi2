'use client'

// Stock adjustment dialog: add, deduct, or transfer between New and Refurbished.
//
// Every adjustment writes a stock log entry, so the audit trail records who
// changed what and why. Reserved stock cannot be deducted - that quantity is
// already promised to a customer.
//
// Unit-tracked items (lib/inventory/units.ts) move real pieces: adding asks for
// the new pieces' grade, notes and optional own price; deducting or transferring
// can name the exact pieces, otherwise the oldest on the shelf go first.

import { INPUT_LIMITS } from '@/lib/constants/limits'
import { blockDecimalKeys } from '@/lib/client/blockDecimalKeys'
import { useEffect, useState, useRef } from 'react'
import { useWindowFocus } from '@/lib/client/useWindowFocus'
import { MAX_STOCK, MAX_CONDITION_NOTES, clampIntegerInput, clampPriceInput } from '@/lib/constants/limits'
import { X } from 'lucide-react'
import { apiFetch } from '@/lib/apiFetch'
import { GRADE_LABEL, UNIT_GRADES, type TrackingMode, type UnitGrade } from '@/lib/inventory/units'
// Only the fields this modal actually reads. Declared here rather than importing
// a page-level type, so the component stays independent of where it is used.
interface Product {
  id: string
  name: string
  condition: 'New' | 'Refurbished'
  quantity: number
  reservedStock: number
  availableStock: number
  minStock: number
  isSingleItem?: boolean
  trackingMode?: TrackingMode
}

type StockAction = 'add' | 'deduct' | 'transfer'

export interface StockAdjustmentValues {
  action: StockAction
  quantity: number
  targetCondition?: 'New' | 'Refurbished'
  remarks: string
  /** Unit tracking: the exact pieces to deduct or transfer. */
  unitIds?: string[]
  /** Unit tracking, add: the new pieces' grade, notes and own price. */
  unitGrade?: UnitGrade
  unitNotes?: string
  unitPrice?: number | null
}

interface PickableUnit { id: string; unitCode: string; grade: string; conditionNotes: string; priceOverride: number | null; receivedAt: string }

interface StockAdjustmentModalProps {
  product: Product | null
  isOpen: boolean
  onClose: () => void
  onSubmit: (values: StockAdjustmentValues) => Promise<void> | void
  submitting?: boolean
}

export default function StockAdjustmentModal({
  product,
  isOpen,
  onClose,
  onSubmit,
  submitting = false,
}: StockAdjustmentModalProps) {
  const [action, setAction] = useState<StockAction>('add')
  const [quantity, setQuantity] = useState('1')
  const [targetCondition, setTargetCondition] = useState<'New' | 'Refurbished'>('Refurbished')
  const [remarks, setRemarks] = useState('')
  const [unitGrade, setUnitGrade] = useState<UnitGrade>('Good')
  const [unitNotes, setUnitNotes] = useState('')
  const [unitPrice, setUnitPrice] = useState('')
  const [pickable, setPickable] = useState<PickableUnit[] | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())

  const unitTracked = product?.trackingMode === 'unit'

  useEffect(() => {
    if (!isOpen || !product) return
    // A single item can only be deducted - see the adjust route.
    // Unit-tracked items take new stock through Receive stock and change
    // condition by re-grading pieces, so only deduction is offered here.
    setAction(product.isSingleItem || product.trackingMode === 'unit' ? 'deduct' : 'add')
    setQuantity('1')
    setTargetCondition(product.condition === 'New' ? 'Refurbished' : 'New')
    setRemarks('')
    setUnitGrade(product.condition === 'New' ? 'New' : 'Good')
    setUnitNotes('')
    setUnitPrice('')
    setPicked(new Set())
    setPickable(null)
  }, [isOpen, product])

  // The pieces on the shelf, for choosing which ones to deduct or transfer.
  useEffect(() => {
    if (!isOpen || !product || product.trackingMode !== 'unit' || action === 'add' || pickable) return
    let cancelled = false
    apiFetch(`/api/inventory/${product.id}/units?status=in_stock`)
      .then((r) => (r.ok ? r.json() : { data: [] }))
      .then((d: { data?: PickableUnit[] }) => { if (!cancelled) setPickable(d.data ?? []) })
      .catch(() => { if (!cancelled) setPickable([]) })
    return () => { cancelled = true }
  }, [isOpen, product, action, pickable])

  // Focus moves into the window and Tab stays inside it.
  const panelRef = useRef<HTMLDivElement>(null)
  useWindowFocus(panelRef, isOpen && !!product)
  // Esc closes, like the other windows (not while saving).
  useEffect(() => {
    if (!(isOpen && !!product)) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !submitting) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, product, submitting, onClose])

  if (!isOpen || !product) return null

  const alternateCondition = product.condition === 'New' ? 'Refurbished' : 'New'

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    // Named pieces decide the quantity; otherwise the typed number, oldest first.
    const namedPieces = unitTracked && action !== 'add' ? Array.from(picked) : []
    const parsedQuantity = namedPieces.length > 0 ? namedPieces.length : Math.floor(Number(quantity))
    if (!Number.isFinite(parsedQuantity) || parsedQuantity <= 0) {
      return
    }

    await onSubmit({
      action,
      quantity: parsedQuantity,
      targetCondition: action === 'transfer' ? targetCondition : undefined,
      remarks: remarks.trim(),
      ...(namedPieces.length > 0 ? { unitIds: namedPieces } : {}),
      ...(unitTracked && action === 'add'
        ? { unitGrade, unitNotes: unitNotes.trim(), unitPrice: unitPrice.trim() ? Number(unitPrice) : null }
        : {}),
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" role="dialog" aria-modal="true" aria-labelledby="adjust-modal-title">
      <div ref={panelRef} className="w-full max-w-2xl rounded-xl bg-white p-6 shadow-sm">
        <div className="mb-5 flex items-center justify-between">
          <div>
            <h2 id="adjust-modal-title" className="text-lg font-semibold text-slate-900">Adjust stock</h2>
            <p className="text-sm text-slate-500">
              {product.name} ({product.condition} variant)
            </p>
          </div>
          <button onClick={onClose} className="text-slate-500 transition hover:text-slate-700" title="Close" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mb-5 grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700 sm:grid-cols-3">
          <div>
            <p className="text-slate-500">Current stock</p>
            <p className="font-semibold text-slate-900">{product.quantity}</p>
          </div>
          <div>
            <p className="text-slate-500">Reserved</p>
            <p className="font-semibold text-slate-900">{product.reservedStock}</p>
          </div>
          <div>
            <p className="text-slate-500">Available to Adjust</p>
            <p className="font-semibold text-slate-900">{product.availableStock}</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-900">Action</label>
              <select
                value={action}
                onChange={(event) => setAction(event.target.value as StockAction)}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-slate-500"
              >
                {!product.isSingleItem && !unitTracked && <option value="add">Add stock</option>}
                <option value="deduct">Deduct Stock</option>
                {!product.isSingleItem && !unitTracked && <option value="transfer">Transfer to Another Condition</option>}
              </select>
              {unitTracked && !product.isSingleItem && (
                <p className="text-xs text-slate-500">
                  To add pieces use Add on the item row. To change a piece&apos;s condition, re-grade it under Units.
                </p>
              )}
              {product.isSingleItem && (
                <p className="text-xs text-slate-500">
                  This is a single item, so it can only be deducted. Add another unit as its own item.
                </p>
              )}
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-900">Quantity</label>
              {unitTracked && action !== 'add' && picked.size > 0 ? (
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700">
                  {picked.size} chosen piece{picked.size === 1 ? '' : 's'}
                </div>
              ) : (
              <input
                type="text"
                inputMode="numeric"
                maxLength={String(MAX_STOCK).length}
                value={quantity}
                onKeyDown={blockDecimalKeys} onChange={(event) => setQuantity(clampIntegerInput(event.target.value, quantity))}
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-slate-500"
                required
              />
              )}
            </div>
          </div>

          {/* New pieces: their grade, notes and optional own price. */}
          {unitTracked && action === 'add' && (
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-900">Grade</label>
                <select value={unitGrade} onChange={(e) => setUnitGrade(e.target.value as UnitGrade)}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-slate-500">
                  {UNIT_GRADES.map((g) => <option key={g} value={g}>{GRADE_LABEL[g]}</option>)}
                </select>
              </div>
              <div className="space-y-2 sm:col-span-2">
                <label className="text-sm font-medium text-slate-900">Condition of these pieces <span className="font-normal text-slate-500">(optional)</span></label>
                <input value={unitNotes} maxLength={MAX_CONDITION_NOTES} onChange={(e) => setUnitNotes(e.target.value)}
                  placeholder="e.g. complete with box"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-slate-500" />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-900">Own price <span className="font-normal text-slate-500">(optional)</span></label>
                <input maxLength={INPUT_LIMITS.money} value={unitPrice} inputMode="decimal" placeholder="Item price"
                  onChange={(e) => setUnitPrice(clampPriceInput(e.target.value, unitPrice))}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-slate-500" />
              </div>
              <p className="text-xs text-slate-500 sm:col-span-2 sm:self-end">
                Each new piece gets its own code. Print their labels from the confirmation, or later under Units.
              </p>
            </div>
          )}

          {/* Choosing which pieces leave. None chosen = oldest first. */}
          {unitTracked && action !== 'add' && (
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-900">
                Which pieces <span className="font-normal text-slate-500">(optional - oldest first if none chosen)</span>
              </label>
              <div className="max-h-44 overflow-y-auto rounded-lg border border-slate-200">
                {pickable === null ? (
                  <p className="px-3 py-3 text-xs text-slate-500">Loading pieces…</p>
                ) : pickable.length === 0 ? (
                  <p className="px-3 py-3 text-xs text-slate-500">No pieces on the shelf.</p>
                ) : pickable.map((u) => (
                  <label key={u.id} className="flex cursor-pointer items-center gap-2.5 border-b border-slate-100 px-3 py-1.5 text-xs last:border-0 hover:bg-slate-50">
                    <input type="checkbox" checked={picked.has(u.id)} className="h-3.5 w-3.5 accent-sky-900"
                      onChange={() => setPicked((s) => { const n = new Set(s); n.has(u.id) ? n.delete(u.id) : n.add(u.id); return n })} />
                    <span className="font-mono text-slate-600">{u.unitCode}</span>
                    <span className="font-semibold text-slate-800">{u.grade}</span>
                    <span className="min-w-0 flex-1 truncate text-slate-500">{u.conditionNotes}</span>
                    {u.priceOverride !== null && <span className="tabular-nums text-blue-700">₱{u.priceOverride.toLocaleString('en-PH')}</span>}
                  </label>
                ))}
              </div>
            </div>
          )}

          {action === 'transfer' ? (
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-900">Transfer To Condition</label>
              <select
                value={targetCondition}
                onChange={(event) => setTargetCondition(event.target.value === 'New' ? 'New' : 'Refurbished')}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-slate-500"
              >
                <option value={alternateCondition}>{alternateCondition}</option>
              </select>
              <p className="text-xs text-slate-500">
                This moves quantity from the current variant into a separate {alternateCondition.toLowerCase()} variant record.
              </p>
            </div>
          ) : null}

          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-900">Remarks</label>
            <textarea maxLength={INPUT_LIMITS.note}
              value={remarks}
              onChange={(event) => setRemarks(event.target.value)}
              placeholder="Optional reason or reference"
              rows={3}
              className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-slate-500"
            />
          </div>

          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={submitting}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? 'Saving...' : 'Apply adjustment'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
