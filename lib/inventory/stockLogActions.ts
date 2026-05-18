// Stock log action types - categorizes what action was performed on inventory
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
  | 'item_voided'
  | 'item_unvoided'
  | 'unmapped_action'

// Human-readable labels for each action type (displayed in audit trail)
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
  item_voided: 'Item Voided',
  item_unvoided: 'Item Restored (Unvoided)',
  unmapped_action: 'Unmapped Action',
}

// Maps old or alternate action names to standardized action types
const ACTION_ALIASES: Record<string, ResolvedStockLogAction> = {
  create_item: 'item_added',
  delete_item: 'item_deleted',
  stock_add: 'stock_increased',
  stock_deduct: 'stock_decreased',
  item_edit: 'item_edited',
  void_item: 'item_voided',
  unvoid_item: 'item_unvoided',
  condition_change: 'condition_changed',
  condition_transfer: 'transfer',
}

const KNOWN_ACTIONS = new Set<ResolvedStockLogAction>(Object.keys(STOCK_LOG_ACTION_LABELS) as ResolvedStockLogAction[])

// Helper: Normalize action value to lowercase with underscores (create_item -> create_item)
const normalizeActionValue = (value: unknown) =>
  typeof value === 'string' ? value.trim().toLowerCase().replace(/[\s-]+/g, '_') : ''

// Helper: Convert normalized value to standard action type via aliases or direct match
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

// Convert any action value to a valid action type for storage
export const normalizeStockLogActionForStorage = (value: unknown) => {
  const normalized = normalizeActionValue(value)
  const mapped = mapKnownAction(normalized)
  return mapped
}

// Check if a value is a recognized action type
export const isRecognizedStockLogAction = (value: unknown) => mapKnownAction(normalizeActionValue(value)) !== null

// Main resolver: determines action type from actionType, remarks, or stock/reserved changes
export const resolveStockLogAction = (input: {
  actionType?: unknown
  remarks?: unknown
  quantityChanged?: number
  stockBefore?: number
  stockAfter?: number
  reservedBefore?: number
  reservedAfter?: number
}) => {
  // Step 1: Try direct match on actionType
  const normalized = normalizeActionValue(input.actionType)
  const directMatch = mapKnownAction(normalized)
  if (directMatch) {
    // Resolve generic 'stock_adjust' to more specific action based on direction
    if (directMatch === 'stock_adjust') {
      if ((input.quantityChanged ?? 0) > 0) return 'stock_increased'
      if ((input.quantityChanged ?? 0) < 0) return 'stock_decreased'
    }

    return directMatch
  }

  // Step 2: Try to infer from remarks text
  const remarks = typeof input.remarks === 'string' ? input.remarks.toLowerCase() : ''
  if (remarks.includes('reservation') && remarks.includes('released')) return 'reservation_release'
  if (remarks.includes('reservation') && remarks.includes('claimed')) return 'reservation_claim'
  if (remarks.includes('reservation') && remarks.includes('created')) return 'reservation_deduction'
  if (remarks.includes('sale') && remarks.includes('completed')) return 'sale_deduction'
  if (remarks.includes('condition changed')) return 'condition_changed'
  if (remarks.includes('voided')) return 'item_voided'
  if (remarks.includes('unvoided') || remarks.includes('restored from void')) return 'item_unvoided'
  if (remarks.includes('restored')) return 'item_restored'
  if (remarks.includes('moved to trash') || remarks.includes('deleted')) return 'item_deleted'
  if (remarks.includes('created') && remarks.includes('inventory')) return 'item_added'
  if (remarks.includes('manual stock increase')) return 'stock_increased'
  if (remarks.includes('manual stock deduction')) return 'stock_decreased'

  // Step 3: Infer from stock and reserved quantity changes
  const stockBefore = input.stockBefore ?? 0
  const stockAfter = input.stockAfter ?? 0
  const reservedBefore = input.reservedBefore ?? 0
  const reservedAfter = input.reservedAfter ?? 0
  const quantityChanged = input.quantityChanged ?? 0

  // Reserved went up, stock same = reservation created
  if (reservedAfter > reservedBefore && stockAfter === stockBefore && quantityChanged < 0) {
    return 'reservation_deduction'
  }

  // Reserved went down, stock same = reservation expired/cancelled
  if (reservedAfter < reservedBefore && stockAfter === stockBefore && quantityChanged > 0) {
    return 'reservation_release'
  }

  // Reserved went down AND stock went down = reservation claimed/sold
  if (reservedAfter < reservedBefore && stockAfter < stockBefore && quantityChanged < 0) {
    return 'reservation_claim'
  }

  // Stock increased
  if (stockAfter > stockBefore && quantityChanged > 0) {
    return 'stock_increased'
  }

  // Stock decreased
  if (stockAfter < stockBefore && quantityChanged < 0) {
    return 'stock_decreased'
  }

  return 'unmapped_action'
}

// Returns a human-readable label for a given stock log action type
export const getStockLogActionLabel = (action: ResolvedStockLogAction) => STOCK_LOG_ACTION_LABELS[action]
