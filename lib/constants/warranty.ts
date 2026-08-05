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

// ── Seller details printed on the sales invoice ───────────────────────────────
//
// Under RA 11976 (Ease of Paying Taxes Act) and RR 7-2024, the INVOICE is the
// primary document for sales of both goods and services; the Official Receipt
// became a supplementary document. A registered invoice must carry the seller's
// registered name, TIN and business address alongside the date and the
// quantity, unit cost and description of each item.
//
// These are stored in Firestore at storeSettings/general so the owner enters
// them once in Settings. They are blank by default rather than guessed, because
// printing a wrong TIN is worse than printing none.
//
// NOTE: carrying the required fields does not make the document tax-valid. That
// requires the system to be BIR-registered as a Computerized Accounting System
// with a Permit to Use, which is outside the scope of this project.
export const DEFAULT_SELLER_TIN = ''
export const DEFAULT_SELLER_ADDRESS = ''
export const DEFAULT_SELLER_REGISTERED_NAME = ''
