'use client'

// How many table rows fit in a scroll box, so a paged list fills its window
// instead of stopping at a fixed 8 rows and leaving the rest blank.
//
//   const { ref, rows } = useFitRows()
//   <div ref={ref} className="min-h-0 flex-1 overflow-auto"><table>…<tr data-row>…
//
// Rows are measured from the rendered <tr data-row> elements (the shortest
// one, so a row whose buttons wrap does not shrink the page), and re-measured
// whenever the box changes size.

import { useCallback, useLayoutEffect, useRef, useState } from 'react'

export function useFitRows({ fallbackRowPx = 54, min = 4, initial = 8 } = {}) {
  const [el, setEl] = useState<HTMLElement | null>(null)
  const [rows, setRows] = useState(initial)
  const ref = useCallback((node: HTMLElement | null) => setEl(node), [])
  const measureRef = useRef<() => void>(() => {})

  measureRef.current = () => {
    if (!el || el.clientHeight === 0) return
    const head = el.querySelector('thead')?.getBoundingClientRect().height ?? 0
    const heights = Array.from(el.querySelectorAll<HTMLElement>('tbody tr[data-row]'), (r) => r.getBoundingClientRect().height).filter((h) => h > 0)
    const row = heights.length ? Math.min(...heights) : fallbackRowPx
    const fit = Math.max(min, Math.floor((el.clientHeight - head) / row))
    setRows((current) => (current === fit ? current : fit))
  }

  // After every render (rows may have just appeared), and on resize.
  useLayoutEffect(() => { measureRef.current() })
  useLayoutEffect(() => {
    if (!el) return
    const observer = new ResizeObserver(() => measureRef.current())
    observer.observe(el)
    return () => observer.disconnect()
  }, [el])

  return { ref, rows }
}
