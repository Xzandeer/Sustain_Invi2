// Whole-number boxes (pieces, minimum stock, adjust quantity, policy days).
//
// Typing "." or "," used to be stripped silently, so "2.5" became 25. Now the
// key is refused with a short message, and the digits typed straight after it
// (the decimal part) are refused too, so "2.5" stays 2 rather than becoming 25.
// Any other key (Backspace, an arrow, leaving the box) ends that.
// clampIntegerInput refuses a pasted decimal the same way.

import type { KeyboardEvent } from 'react'
import { toast } from 'sonner'

export const NO_DECIMALS_MESSAGE = "Can't add decimals. Whole numbers only."

const warn = () => toast.error(NO_DECIMALS_MESSAGE, { id: 'no-decimals' }) // one message, even if repeated

/** onKeyDown for a whole-number input. */
export function blockDecimalKeys(e: KeyboardEvent<HTMLInputElement>) {
  const box = e.currentTarget
  if (e.key === '.' || e.key === ',') {
    e.preventDefault()
    box.dataset.afterDecimal = '1'
    box.addEventListener('blur', () => { delete box.dataset.afterDecimal }, { once: true })
    warn()
  } else if (box.dataset.afterDecimal && /^\d$/.test(e.key)) {
    e.preventDefault() // the decimal part of what was typed
    warn()
  } else {
    delete box.dataset.afterDecimal
    // A number box would otherwise accept these (1e3, -5).
    if (e.key === 'e' || e.key === 'E' || e.key === '+' || e.key === '-') e.preventDefault()
  }
}
