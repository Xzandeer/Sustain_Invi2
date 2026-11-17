// Keyboard behaviour shared by the app's windows (New sale, Reserve item,
// Add stock, Edit item, Adjust stock, Categories):
//   - on open, focus moves into the window (its first field, else first button);
//   - Tab and Shift+Tab cycle inside the window instead of wandering to the
//     page behind it;
//   - on close, focus returns to whatever opened the window.
// Esc stays with each window, because some ask before discarding work.

import { useEffect, type RefObject } from 'react'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function useWindowFocus(ref: RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    if (!active) return
    const root = ref.current
    if (!root) return
    const previous = document.activeElement as HTMLElement | null
    const focusables = () => Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter((el) => el.getClientRects().length > 0)

    if (!root.contains(document.activeElement)) {
      const field = root.querySelector<HTMLElement>('input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled])')
      ;(field && field.getClientRects().length > 0 ? field : focusables()[0])?.focus()
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const list = focusables()
      if (list.length === 0) return
      const first = list[0]
      const last = list[list.length - 1]
      const here = document.activeElement
      if (e.shiftKey && (here === first || !root.contains(here))) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && (here === last || !root.contains(here))) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      if (previous && document.contains(previous)) previous.focus()
    }
  }, [ref, active])
}
