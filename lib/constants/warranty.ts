// Store-wide warranty / refund window.
//
// The value is stored in Firestore at  storeSettings/general  as `warrantyDays`
// and is editable by the administrator in Settings → Store Policy.
// This constant is only the fallback used when the setting has not been saved yet.

export const DEFAULT_WARRANTY_DAYS = 7

// Kept for backwards compatibility with code that imported the old constant.
export const WARRANTY_DAYS = DEFAULT_WARRANTY_DAYS

export const SETTINGS_COLLECTION = 'storeSettings'
export const SETTINGS_DOC = 'general'

// Refund reason categories — used by the refund UI and for analytics grouping.
export const REFUND_REASONS = [
  'Defective / Damaged item',
  'Wrong item released',
  'Customer changed mind',
  'Item not as described',
  'Duplicate transaction',
  'Other',
] as const

export type RefundReason = (typeof REFUND_REASONS)[number]
