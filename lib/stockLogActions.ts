export type ResolvedStockLogAction =
  | 'item_added'
  | 'stock_increased'
  | 'stock_decreased'
  | 'stock_adjust'
  | 'item_edited'
  | 'condition_changed'
  | 'stock_transferred_out'
  | 'stock_transferred_in'
  | 'transfer'
  | 'sale_deduction'
  | 'reservation_deduction'
  | 'reservation_claim'
  | 'reservation_release'
  | 'item_deleted'
  | 'item_restored'
  | 'item_deleted_permanently'
  | 'unmapped_action'

const STOCK_LOG_ACTION_LABELS: Record<ResolvedStockLogAction, string> = {
  item_added: 'Item Created',
  stock_increased: 'Stock Added',
  stock_decreased: 'Stock Deducted',
  stock_adjust: 'Stock Adjusted',
  item_edited: 'Item Edited',
  condition_changed: 'Condition Changed',
  stock_transferred_out: 'Transfer Out',
  stock_transferred_in: 'Transfer In',
  transfer: 'Stock Transfer',
  sale_deduction: 'Sale Deduction',
  reservation_deduction: 'Reservation Deduction',
  reservation_claim: 'Reservation Claim',
  reservation_release: 'Reservation Release',
  item_deleted: 'Item Deleted',
  item_restored: 'Item Restored',
  item_deleted_permanently: 'Item Deleted Permanently',
  unmapped_action: 'Unmapped Action',
}

const ACTION_ALIASES: Record<string, ResolvedStockLogAction> = {
  create_item: 'item_added',
  delete_item: 'item_deleted',
  stock_add: 'stock_increased',
  stock_deduct: 'stock_decreased',
  item_edit: 'item_edited',
  condition_change: 'condition_changed',
  condition_transfer: 'transfer',
}

const KNOWN_ACTIONS = new Set<ResolvedStockLogAction>(Object.keys(STOCK_LOG_ACTION_LABELS) as ResolvedStockLogAction[])

const normalizeActionValue = (value: unknown) =>
  typeof value === 'string' ? value.trim().toLowerCase().replace(/[\s-]+/g, '_') : ''

const mapKnownAction = (value: string): ResolvedStockLogAction | null => {
  if (!value) return null
  if (value in ACTION_ALIASES) {
    return ACTION_ALIASES[value]
  }

  if (KNOWN_ACTIONS.has(value as ResolvedStockLogAction)) {
    return value as ResolvedStockLogAction
  }

  return null
}

export const normalizeStockLogActionForStorage = (value: unknown) => {
  const normalized = normalizeActionValue(value)
  const mapped = mapKnownAction(normalized)
  return mapped
}

export const isRecognizedStockLogAction = (value: unknown) => mapKnownAction(normalizeActionValue(value)) !== null

export const resolveStockLogAction = (input: {
  actionType?: unknown
  remarks?: unknown
  quantityChanged?: number
  stockBefore?: number
  stockAfter?: number
  reservedBefore?: number
  reservedAfter?: number
}) => {
  const normalized = normalizeActionValue(input.actionType)
  const directMatch = mapKnownAction(normalized)
  if (directMatch) {
    if (directMatch === 'stock_adjust') {
      if ((input.quantityChanged ?? 0) > 0) return 'stock_increased'
      if ((input.quantityChanged ?? 0) < 0) return 'stock_decreased'
    }

    return directMatch
  }

  const remarks = typeof input.remarks === 'string' ? input.remarks.toLowerCase() : ''
  if (remarks.includes('reservation') && remarks.includes('released')) return 'reservation_release'
  if (remarks.includes('reservation') && remarks.includes('claimed')) return 'reservation_claim'
  if (remarks.includes('reservation') && remarks.includes('created')) return 'reservation_deduction'
  if (remarks.includes('sale') && remarks.includes('completed')) return 'sale_deduction'
  if (remarks.includes('condition changed')) return 'condition_changed'
  if (remarks.includes('restored')) return 'item_restored'
  if (remarks.includes('moved to trash') || remarks.includes('deleted')) return 'item_deleted'
  if (remarks.includes('created') && remarks.includes('inventory')) return 'item_added'
  if (remarks.includes('manual stock increase')) return 'stock_increased'
  if (remarks.includes('manual stock deduction')) return 'stock_decreased'

  const stockBefore = input.stockBefore ?? 0
  const stockAfter = input.stockAfter ?? 0
  const reservedBefore = input.reservedBefore ?? 0
  const reservedAfter = input.reservedAfter ?? 0
  const quantityChanged = input.quantityChanged ?? 0

  if (reservedAfter > reservedBefore && stockAfter === stockBefore && quantityChanged < 0) {
    return 'reservation_deduction'
  }

  if (reservedAfter < reservedBefore && stockAfter === stockBefore && quantityChanged > 0) {
    return 'reservation_release'
  }

  if (reservedAfter < reservedBefore && stockAfter < stockBefore && quantityChanged < 0) {
    return 'reservation_claim'
  }

  if (stockAfter > stockBefore && quantityChanged > 0) {
    return 'stock_increased'
  }

  if (stockAfter < stockBefore && quantityChanged < 0) {
    return 'stock_decreased'
  }

  return 'unmapped_action'
}

export const getStockLogActionLabel = (action: ResolvedStockLogAction) => STOCK_LOG_ACTION_LABELS[action]
