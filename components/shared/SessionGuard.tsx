'use client'

// Ends a sign-in that should not still be open.
//
// A shop computer is shared, so a session must not outlive the person using
// it. Three rules, on top of sign-in being kept per tab only (lib/firebase.js):
//
//   1. Coming back with the browser's Back / Forward button signs out. Leaving
//      the site and stepping back into it used to land on the dashboard, still
//      signed in - anyone at the keyboard could do it.
//   2. No activity for IDLE_MINUTES signs out.
//   3. Returning after being away longer than that (tab left in the
//      background, computer asleep) signs out too.
//
// Moving between pages inside the app is not affected: those are not page
// loads. A normal refresh keeps the session.

import { useEffect } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { onAuthStateChanged, signOut } from 'firebase/auth'
import { auth } from '@/lib/firebase'

export const IDLE_MINUTES = 30
const IDLE_MS = IDLE_MINUTES * 60 * 1000
const LAST_ACTIVE_KEY = 'sustain.lastActive'
/** Read by the login page to say why the session ended. */
export const SIGNED_OUT_REASON_KEY = 'sustain.signedOutReason'

const read = (key: string) => { try { return window.sessionStorage.getItem(key) } catch { return null } }
const write = (key: string, value: string) => { try { window.sessionStorage.setItem(key, value) } catch { /* private mode */ } }

export default function SessionGuard() {
  const router = useRouter()
  const pathname = usePathname()

  useEffect(() => {
    let signedIn = false
    let ending = false

    const end = async (reason: string) => {
      if (ending) return
      ending = true
      write(SIGNED_OUT_REASON_KEY, reason)
      try { await signOut(auth) } catch { /* already signed out */ }
      router.replace('/login')
      ending = false
    }

    // 1. Arrived by Back / Forward, as a fresh load or from the browser's page cache.
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
    const cameBack = nav?.type === 'back_forward'
    const onPageShow = (e: PageTransitionEvent) => { if (e.persisted && signedIn) void end('You left the site, so you were signed out.') }

    // 3. Away for too long before this load.
    const last = Number(read(LAST_ACTIVE_KEY) || 0)
    const awayTooLong = last > 0 && Date.now() - last > IDLE_MS

    // The arrival rules apply only to a session that was already open when the
    // page loaded - the first auth state reported. Signing in afterwards on
    // this page is a new session and starts its own clock.
    let firstState = true
    const unsub = onAuthStateChanged(auth, (user) => {
      signedIn = !!user
      const arriving = firstState
      firstState = false
      if (!user) return
      if (arriving && cameBack) { void end('You left the site, so you were signed out.'); return }
      if (arriving && awayTooLong) { void end(`Signed out after ${IDLE_MINUTES} minutes without activity.`); return }
      write(LAST_ACTIVE_KEY, String(Date.now()))
    })

    // 2. Idle timer.
    let lastWrite = 0
    const active = () => {
      const now = Date.now()
      if (now - lastWrite < 5000) return // at most one write every 5 seconds
      lastWrite = now
      if (signedIn) write(LAST_ACTIVE_KEY, String(now))
    }
    const check = () => {
      if (!signedIn) return
      const seen = Number(read(LAST_ACTIVE_KEY) || 0)
      if (seen > 0 && Date.now() - seen > IDLE_MS) void end(`Signed out after ${IDLE_MINUTES} minutes without activity.`)
    }
    const events: Array<keyof WindowEventMap> = ['pointerdown', 'keydown', 'wheel', 'touchstart']
    events.forEach((e) => window.addEventListener(e, active, { passive: true }))
    const onVisible = () => { if (document.visibilityState === 'visible') check() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('pageshow', onPageShow)
    const timer = window.setInterval(check, 30_000)

    return () => {
      unsub()
      events.forEach((e) => window.removeEventListener(e, active))
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('pageshow', onPageShow)
      window.clearInterval(timer)
    }
    // Runs once per page load; the router is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Moving between pages counts as activity.
  useEffect(() => { write(LAST_ACTIVE_KEY, String(Date.now())) }, [pathname])

  return null
}
