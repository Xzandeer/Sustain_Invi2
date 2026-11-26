'use client'

// A small (i) that shows an explanation on hover, keyboard focus or tap.
//
// Panels used to carry their explanations as paragraphs or "What this shows"
// links, which made every card taller and busier. The text is still one
// hover away. Esc or a tap elsewhere closes it.
//
// Keep it out of <p> and headings: the tip is a block of text, so place it
// beside them in a flex row.

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Info } from 'lucide-react'

export default function InfoTip({
  label,
  children,
  align = 'left',
  wide = false,
  above = false,
}: {
  /** Read by screen readers, e.g. "About this chart". */
  label: string
  children: ReactNode
  /** Which edge the tip lines up with - 'right' for icons near a card's right side. */
  align?: 'left' | 'right'
  wide?: boolean
  /** Open upwards - for icons at the bottom of a card. */
  above?: boolean
}) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const ref = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <span
      ref={ref}
      className="relative inline-flex shrink-0 align-middle"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen(true)}
        className="flex h-4 w-4 items-center justify-center rounded-full text-slate-400 transition-colors hover:text-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-300"
      >
        <Info className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      {open && (
        <span
          role="tooltip"
          id={id}
          className={`absolute z-40 block ${above ? 'bottom-full mb-1.5' : 'top-full mt-1.5'} ${align === 'right' ? 'right-0' : 'left-0'} ${wide ? 'w-80' : 'w-64'} rounded-lg border border-slate-200 bg-white p-2.5 text-left text-[11px] font-normal normal-case leading-relaxed tracking-normal text-slate-600 shadow-lg`}
        >
          {children}
        </span>
      )}
    </span>
  )
}
