'use client'

// Layout shared by every dashboard page - sidebar, top bar and the floating
// AI assistant. Pages render inside this.
//
// MOBILE
// The sidebar is a fixed 208px column on tablet and desktop. On a phone that
// would consume most of the screen before any content renders, so below the
// `md` breakpoint it becomes a slide-over drawer opened from a compact top bar,
// and the main content takes the full width.
//
// The drawer closes on navigation, because leaving it open over the page the
// user just asked for is disorienting on a small screen.

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import Sidebar from '@/components/layout/Sidebar'
import FloatingChatBot from '@/components/chatbot/FloatingChatBot'
import { AI_ASSISTANT_ENABLED } from '@/lib/ai/assistantEnabled'

export default function DashboardLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  const [navOpen, setNavOpen] = useState(false)
  const pathname = usePathname()

  // Close the drawer whenever the route changes
  useEffect(() => { setNavOpen(false) }, [pathname])

  // A drawer over a scrolling page lets the background move underneath, which
  // reads as broken. Lock the body while it is open.
  // Escape closes the drawer, as it does any overlay.
  useEffect(() => {
    if (!navOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setNavOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navOpen])

  useEffect(() => {
    if (!navOpen) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previous }
  }, [navOpen])

  return (
    <div className="flex min-h-screen">
      {/* Desktop and tablet: permanent column */}
      <div className="fixed left-0 top-0 hidden h-screen w-52 md:block">
        <Sidebar />
      </div>

      {/* Phone: drawer */}
      {navOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setNavOpen(false)}
            aria-hidden
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            className="absolute left-0 top-0 h-full w-60 shadow-[4px_0_24px_rgba(15,23,42,0.35)]"
          >
            <Sidebar onClose={() => setNavOpen(false)} />
          </div>
        </div>
      )}

      <main className="min-h-screen w-full overflow-y-auto bg-[#f5f6fa] md:ml-52">
        {/* Phone top bar. Hidden from md up, where the sidebar is always visible. */}
        <div className="sticky top-0 z-30 flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-3 md:hidden">
          <button
            type="button"
            onClick={() => setNavOpen(true)}
            aria-label="Open menu"
            className="rounded-lg p-1.5 text-slate-600 transition hover:bg-slate-100"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <span className="text-sm font-bold tracking-tight text-slate-900">
            JMGs <span className="text-slate-400">JAPAN SURPLUS</span>
          </span>
        </div>

        {children}
      </main>

      {/* Switched off - see lib/ai/assistantEnabled.ts for why, and to
          turn it back on. Forecasting does not go through this. */}
      {AI_ASSISTANT_ENABLED && <FloatingChatBot />}
    </div>
  )
}
