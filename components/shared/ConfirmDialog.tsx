'use client'

// The app's own "Are you sure?" window, used instead of the browser's
// window.confirm() (a grey "localhost:3000 says…" box that cannot be styled and
// looks nothing like the rest of the system).
//
//   const { confirm, confirmDialog } = useConfirm()
//   if (!(await confirm({ title: 'Extend the hold?', message: 'For Juan Dela Cruz.' }))) return
//   ...
//   return <>{...}{confirmDialog}</>
//
// It sits above every other window. Esc or Cancel answers "no", Enter or the
// main button "yes". Its keys are caught before any window underneath sees
// them, so Esc here never also closes that window.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export interface ConfirmOptions {
  title: string
  message?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  /** 'danger' for discarding or releasing something; 'primary' otherwise. */
  tone?: 'primary' | 'danger' | 'success'
}

interface Pending extends ConfirmOptions { resolve: (ok: boolean) => void }

const TONE = {
  primary: 'bg-blue-600 hover:bg-blue-700 focus-visible:ring-blue-300',
  danger: 'bg-rose-600 hover:bg-rose-700 focus-visible:ring-rose-300',
  success: 'bg-emerald-600 hover:bg-emerald-700 focus-visible:ring-emerald-300',
}

export function useConfirm() {
  const [pending, setPending] = useState<Pending | null>(null)

  const confirm = useCallback((options: ConfirmOptions) => new Promise<boolean>((resolve) => {
    setPending({ ...options, resolve })
  }), [])

  const answer = useCallback((ok: boolean) => {
    setPending((p) => { p?.resolve(ok); return null })
  }, [])

  const confirmDialog = pending ? <ConfirmWindow options={pending} onAnswer={answer} /> : null
  return { confirm, confirmDialog }
}

function ConfirmWindow({ options, onAnswer }: { options: ConfirmOptions; onAnswer: (ok: boolean) => void }) {
  const okRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    okRef.current?.focus()
    // Capture phase on window runs before any other window's key listener.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); onAnswer(false) }
      else if (e.key === 'Enter' && document.activeElement !== cancelRef.current) { e.preventDefault(); e.stopImmediatePropagation(); onAnswer(true) }
      else if (e.key === 'Tab') {
        // Keep focus on the two buttons (and away from any window underneath).
        e.preventDefault(); e.stopImmediatePropagation()
        ;(document.activeElement === okRef.current ? cancelRef.current : okRef.current)?.focus()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('keydown', onKey, true); previous?.focus?.() }
  }, [onAnswer])

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/40 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onAnswer(false) }}>
      <div role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby={options.message ? 'confirm-message' : undefined}
        className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-2xl">
        <h2 id="confirm-title" className="text-base font-semibold text-slate-900">{options.title}</h2>
        {options.message && <div id="confirm-message" className="mt-1.5 text-sm text-slate-600">{options.message}</div>}
        <div className="mt-5 flex justify-end gap-2">
          <button ref={cancelRef} type="button" onClick={() => onAnswer(false)}
            className="h-9 rounded-lg border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300">
            {options.cancelLabel ?? 'Cancel'}
          </button>
          <button ref={okRef} type="button" onClick={() => onAnswer(true)}
            className={`h-9 rounded-lg px-4 text-sm font-semibold text-white transition focus-visible:outline-none focus-visible:ring-2 ${TONE[options.tone ?? 'primary']}`}>
            {options.confirmLabel ?? 'Confirm'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
