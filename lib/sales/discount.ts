// The cashier's discount box (Sales page and the Dashboard's quick sale).
//
// A discount must leave something to pay (the server refuses one that does
// not), so the box itself stops there: at most 99.99%, or the subtotal less
// one centavo. Two decimals at most, as money is kept to the centavo.

export type DiscountMode = 'peso' | 'percent'

/** The largest discount the box accepts for this cart. */
export function maxDiscount(mode: DiscountMode, subtotal: number): number {
  if (mode === 'percent') return 99.99
  return Math.max(0, Math.round((subtotal - 0.01) * 100) / 100)
}

/**
 * What the box should hold after the cashier types `raw`: `null` to ignore the
 * keystroke (not a number), otherwise the value, lowered to the limit if over it.
 */
export function limitDiscountInput(raw: string, mode: DiscountMode, subtotal: number): string | null {
  if (raw === '' || raw === '.') return raw
  if (!/^\d*\.?\d{0,2}$/.test(raw)) return null
  const max = maxDiscount(mode, subtotal)
  if (Number(raw) <= max) return raw
  return max > 0 ? String(max) : ''
}
