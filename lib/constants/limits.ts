// Shared bounds for quantity fields.
//
// A stock figure is a count of physical second-hand items on a shelf in one
// small shop. Three digits is already generous; the cap exists so a slipped
// key or a held-down zero cannot write a nonsense figure into inventory and
// through to the dashboard totals and the forecast.
//
// Enforced in the forms and again in the API, because a form can be bypassed.
export const MAX_STOCK = 999
export const MAX_PRICE = 999999

// `max` on <input type="number"> does NOT stop typing. It only marks the field
// invalid on submit, so a user can still type 11111111111111 and watch it sit
// there looking accepted. This is what the adviser found during consultation.
//
// These helpers clamp as the user types. A keystroke that would take the field
// past the limit is simply ignored - the number stops growing rather than
// silently rewriting itself to something the user did not type.

/**
 * Whole-number field (stock, minimum stock, adjustment quantity).
 * Rejects anything non-numeric, leading zeroes and values above `max`.
 * Returns the previous value when the keystroke would exceed the limit.
 */
export function clampIntegerInput(raw: string, previous: string, max = MAX_STOCK): string {
  if (raw === '') return ''                      // allow clearing the field
  const digits = raw.replace(/\D/g, '')
  if (!digits) return previous                   // typed a letter or symbol
  const normalized = digits.replace(/^0+(?=\d)/, '')  // "007" -> "7"
  return Number(normalized) > max ? previous : normalized
}

/**
 * Money field. Same idea, but two decimal places are allowed.
 */
export function clampPriceInput(raw: string, previous: string, max = MAX_PRICE): string {
  if (raw === '') return ''
  if (!/^\d*\.?\d{0,2}$/.test(raw)) return previous   // one dot, max 2 decimals
  return Number(raw) > max ? previous : raw
}
