'use client'

import { ResolvedStockLogAction } from '@/lib/stockLogActions'

interface StockValueDisplayProps {
  label: string
  stock: number
  reserved: number
  available?: number
  condition?: string
}

export function StockValueDisplay({ label, stock, reserved, available, condition }: StockValueDisplayProps) {
  return (
    <div className="min-w-max">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-1.5">{label}</p>
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center px-2 py-1 rounded-md bg-slate-100 text-slate-700">
            <span className="text-xs font-medium">Stock:</span>
            <span className="ml-1.5 font-semibold text-sm text-slate-900">{stock}</span>
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center px-2 py-1 rounded-md bg-violet-100 text-violet-700">
            <span className="text-xs font-medium">Reserved:</span>
            <span className="ml-1.5 font-semibold text-sm text-violet-900">{reserved}</span>
          </span>
        </div>
        {available !== undefined && (
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center px-2 py-1 rounded-md bg-slate-50 text-slate-700">
              <span className="text-xs font-medium">Available:</span>
              <span className="ml-1.5 font-semibold text-sm text-slate-900">{available}</span>
            </span>
          </div>
        )}
        {condition && (
          <div className="flex items-center gap-2 mt-2">
            <span className="inline-flex items-center px-2 py-1 rounded-md bg-sky-100 text-sky-700">
              <span className="text-xs font-medium">Condition:</span>
              <span className="ml-1.5 font-semibold text-sm text-sky-900">{condition}</span>
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

interface ActionBadgeProps {
  action: ResolvedStockLogAction
  label: string
}

export function ActionBadge({ action, label }: ActionBadgeProps) {
  const getClassName = (value: ResolvedStockLogAction) => {
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
      case 'item_deleted':
      case 'item_restored':
        return 'bg-slate-100 text-slate-700'
      default:
        return 'bg-slate-100 text-slate-700'
    }
  }

  return (
    <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${getClassName(action)}`}>
      {label}
    </span>
  )
}

interface QuantityChangeProps {
  change: number
}

export function QuantityChange({ change }: QuantityChangeProps) {
  const getColor = () => {
    if (change > 0) return 'text-emerald-700 bg-emerald-50'
    if (change < 0) return 'text-amber-700 bg-amber-50'
    return 'text-slate-700 bg-slate-50'
  }

  return (
    <span className={`inline-flex items-center rounded-md px-3 py-1.5 font-semibold text-sm ${getColor()}`}>
      {change > 0 ? '+' : ''}
      {change}
    </span>
  )
}
