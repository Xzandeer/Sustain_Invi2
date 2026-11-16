'use client'

// Listens for item scans on every dashboard page except Sales, and turns a
// scan of a real inventory item into a sale.
//
// A USB or Bluetooth scanner is a keyboard: it types the code very fast and
// presses Enter. That speed is what separates a scan from a person typing -
// characters arriving less than SCAN_GAP_MS apart and closed by Enter are a
// scan. Keystrokes in a text field are never taken, so typing anywhere in the
// app works as before.
//
// The Sales page has its own listener (it adds to the cart in place), so this
// one stands down there. Nothing is rendered.

import { useEffect, useRef } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { extractItemCode, saleUrlFor, verifyItemCode } from '@/lib/scan/scanToSale'

const SCAN_GAP_MS = 100

export default function GlobalScanListener() {
  const pathname = usePathname()
  const router = useRouter()
  const bufferRef = useRef('')
  const lastKeyRef = useRef(0)
  const busyRef = useRef(false)

  const onSalesPage = pathname === '/sales' || pathname.startsWith('/sales/')

  useEffect(() => {
    if (onSalesPage) return

    const handleScan = async (raw: string) => {
      const code = extractItemCode(raw)
      if (!code || busyRef.current) return
      busyRef.current = true
      try {
        const item = await verifyItemCode(code)
        toast.success(`${item.name} scanned. Opening a new sale.`)
        router.push(saleUrlFor(code))
      } catch (e) {
        toast.error(e instanceof Error ? e.message : `No item found for code ${code}.`)
      } finally {
        busyRef.current = false
      }
    }

    const onKeyDown = (event: KeyboardEvent) => {
      // A sale window (dashboard New sale) is taking the scans itself.
      if (document.body.dataset.localScan === '1') return
      const active = document.activeElement as HTMLElement | null
      const tag = active?.tagName
      // Never take keystrokes from a field the user is filling in.
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || active?.isContentEditable) return
      if (event.ctrlKey || event.metaKey || event.altKey) return

      const now = Date.now()

      if (event.key === 'Enter') {
        const scanned = bufferRef.current
        bufferRef.current = ''
        // Only a scan if Enter came straight after the burst; a person pressing
        // Enter on a focused button gets the button.
        if (scanned.length >= 4 && now - lastKeyRef.current <= SCAN_GAP_MS) {
          event.preventDefault()
          event.stopPropagation()
          void handleScan(scanned)
        }
        return
      }

      // Any single printable character - a QR code may hold letters too.
      if (event.key.length === 1) {
        if (now - lastKeyRef.current > SCAN_GAP_MS) bufferRef.current = ''
        bufferRef.current += event.key
        lastKeyRef.current = now
        return
      }

      // Shift and other modifiers arrive mid-scan for capitals; ignore them.
      if (event.key === 'Shift') return
      bufferRef.current = ''
    }

    // Capture phase, so the Enter is consumed before a focused button sees it.
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [onSalesPage, router])

  return null
}
