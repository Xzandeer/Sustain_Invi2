'use client'

// Dashboard navigation.
//
// Links are filtered by the signed-in user's permissions, so staff only see
// the sections they are allowed to open. This is a convenience only - the
// real check happens in ProtectedRoute and again on the server.
//
// Compact text links on the dark navy column. The current page is the solid
// blue pill. Inventory carries an amber count of items at or below their
// minimum stock, so a restock need is visible from every page.
// One link is marked current at a time (longest matching route), every link
// has a visible keyboard focus ring, and on a phone the same column opens as a
// drawer with its own close button (see app/(dashboard)/layout.tsx).

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { LogOut, Store, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { onAuthStateChanged, signOut } from 'firebase/auth'
import { collection, doc, getDoc, getDocs } from 'firebase/firestore'
import { toast } from 'sonner'
import { auth, db } from '@/lib/firebase'
import { useUserRole } from '@/hooks/useUserRole'
import type { Permission } from '@/lib/auth/permissions'

// What the signed-in user is allowed to open. Passed to each item's `show`.
interface NavAccess {
  isAdmin: boolean
  canViewStockLogs: boolean
  can: (permission: Permission) => boolean
}

interface NavItemDef {
  name: string
  href: string
  /** Show the needs-restocking count beside this link. */
  restockBadge?: boolean
  /** Omit to always show. */
  show?: (access: NavAccess) => boolean
}

// Each item carries its own visibility rule, matching the guard on the page it
// links to. Keeping the two in the same shape is what stops the sidebar
// offering a link that ProtectedRoute will immediately bounce.
//
// Analytics sits in MAIN, not under a management heading: reading the sales
// trend is part of running the counter, and a staff member with
// canViewAnalytics uses it the same way the owner does.
const NAV_SECTIONS: { title: string; items: NavItemDef[] }[] = [
  {
    title: 'Main',
    items: [
      { name: 'Dashboard',    href: '/dashboard' },
      { name: 'Sales',        href: '/sales' },
      { name: 'Inventory',    href: '/inventory', restockBadge: true },
      {
        name: 'Reservations', href: '/reservations',
        show: (a) => a.isAdmin || a.can('canManageReservations'),
      },
      {
        name: 'Analytics',    href: '/analytics',
        show: (a) => a.isAdmin || a.can('canViewAnalytics'),
      },
    ],
  },
  {
    title: 'Records',
    items: [
      {
        name: 'Stock Logs',   href: '/inventory/logs',
        show: (a) => a.isAdmin || a.canViewStockLogs,
      },
      {
        // Trash restores and permanently deletes items - admin only, matching
        // <ProtectedRoute requireAdmin> on the page itself.
        name: 'Trash',        href: '/inventory/trash',
        show: (a) => a.isAdmin,
      },
    ],
  },
  {
    title: 'Administration',
    items: [
      { name: 'Users',        href: '/users', show: (a) => a.isAdmin },
      { name: 'Settings',     href: '/settings' },
    ],
  },
]

const ALL_HREFS = NAV_SECTIONS.flatMap((s) => s.items.map((i) => i.href))

/**
 * The one link that represents the current page: the longest href that the
 * path equals or sits under. Plain prefix matching marked Inventory as current
 * on /inventory/logs and /inventory/trash as well, so two links lit up.
 */
const currentHref = (pathname: string) =>
  ALL_HREFS
    .filter((href) => pathname === href || pathname.startsWith(`${href}/`))
    .sort((a, b) => b.length - a.length)[0] ?? null

// Shared focus treatment: visible on keyboard focus only, offset from the navy.
const FOCUS_RING =
  'outline-none focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#1a2035]'

// The restock count is re-read at most once a minute as the user moves between
// pages, so a sale or a stock adjustment shows up without a reload.
const RESTOCK_REFRESH_MS = 60_000

interface Profile { name: string; role: string; initials: string }

export default function Sidebar({ onClose }: { /** Set when shown as the phone drawer. */ onClose?: () => void }) {
  const pathname = usePathname()
  const router   = useRouter()
  const { isAdmin, canViewStockLogs, can } = useUserRole()
  const [profile, setProfile] = useState<Profile | null>(null)
  const [signingOut, setSigningOut] = useState(false)
  const [restockCount, setRestockCount] = useState(0)
  const [restockLoadedAt, setRestockLoadedAt] = useState(0)

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) return
      const fallbackName = user.displayName?.trim() || user.email?.split('@')[0] || 'Signed in'
      try {
        const snap = await getDoc(doc(db, 'users', user.uid))
        const d = snap.exists() ? (snap.data() as Record<string, unknown>) : {}
        const name = typeof d.name === 'string' && d.name.trim() ? d.name.trim()
          : typeof d.email === 'string' ? d.email.split('@')[0] : fallbackName
        const role = typeof d.role === 'string' && d.role ? d.role : 'staff'
        setProfile({
          name,
          role: role.charAt(0).toUpperCase() + role.slice(1),
          initials: name.split(/\s+/).map((n) => n[0]).join('').slice(0, 2).toUpperCase(),
        })
      } catch {
        // The profile document is cosmetic here; fall back to the auth record.
        setProfile({ name: fallbackName, role: 'Signed in', initials: fallbackName.slice(0, 2).toUpperCase() })
      }
    })
    return () => unsub()
  }, [])

  // Items at or below their minimum stock - the same rule as the Dashboard's
  // Needs restocking list. Trash and written-off items are left out.
  useEffect(() => {
    if (Date.now() - restockLoadedAt < RESTOCK_REFRESH_MS) return
    let cancelled = false
    ;(async () => {
      await auth.authStateReady()
      if (!auth.currentUser) return
      try {
        const snap = await getDocs(collection(db, 'inventory'))
        if (cancelled) return
        const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0)
        setRestockCount(snap.docs.reduce((n, d) => {
          const data = d.data() as Record<string, unknown>
          if (data.isDeleted === true || data.isVoided === true) return n
          const stock = num(data.stock ?? data.quantity)
          return stock <= 0 || stock <= num(data.minStock) ? n + 1 : n
        }, 0))
        setRestockLoadedAt(Date.now())
      } catch {
        // The badge is a hint only; leave the last known count.
      }
    })()
    return () => { cancelled = true }
  }, [pathname]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleLogout = async () => {
    if (signingOut) return
    setSigningOut(true)
    try {
      await signOut(auth)
      router.push('/login')
    } catch {
      toast.error('Could not sign out. Check your connection and try again.')
      setSigningOut(false)
    }
  }

  const active = currentHref(pathname)

  const visibleSections = useMemo(() => {
    const access: NavAccess = { isAdmin, canViewStockLogs, can }
    return NAV_SECTIONS
      .map(section => ({
        ...section,
        items: section.items.filter(item => !item.show || item.show(access)),
      }))
      .filter(section => section.items.length > 0)
  }, [isAdmin, canViewStockLogs, can])

  return (
    <aside className="flex h-screen w-full flex-col bg-[#1a2035] text-slate-300">

      {/* Brand. Doubles as the way home, as users expect of a logo. */}
      <div className="flex items-center justify-between gap-2 border-b border-white/[0.07] px-3.5 py-3">
        <Link href="/dashboard" className={`flex min-w-0 items-center gap-2.5 rounded-lg ${FOCUS_RING}`}>
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-600 text-white">
            <Store className="h-4 w-4" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[13px] font-bold leading-tight tracking-tight text-white">JMGs JAPAN</span>
            <span className="block text-[10px] font-semibold leading-tight tracking-[0.2em] text-blue-400">SURPLUS</span>
          </span>
        </Link>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close menu"
            autoFocus
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 transition-colors duration-150 hover:bg-white/[0.06] hover:text-white ${FOCUS_RING}`}
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Navigation. One landmark; each section is a labelled group.
          A section renders only if the user can open something inside it. */}
      <nav
        aria-label="Main"
        className="flex flex-1 flex-col gap-4 overflow-y-auto px-2 py-3 [scrollbar-color:rgba(255,255,255,0.15)_transparent] [scrollbar-width:thin]"
      >
        {visibleSections.map(section => {
          const headingId = `nav-${section.title.toLowerCase()}`
          return (
            <div key={section.title} role="group" aria-labelledby={headingId}>
              <p id={headingId} className="mb-1 px-2.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500">
                {section.title}
              </p>
              <ul className="space-y-0.5">
                {section.items.map(item => {
                  const isCurrent = item.href === active
                  const badge = item.restockBadge && restockCount > 0 ? restockCount : null
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        aria-current={isCurrent ? 'page' : undefined}
                        className={`flex items-center justify-between gap-2 rounded-md px-2.5 py-[6px] text-[13px] leading-5 transition-colors duration-150 ${FOCUS_RING} ${
                          isCurrent
                            ? 'bg-blue-600 font-semibold text-white'
                            : 'font-medium text-slate-300 hover:bg-white/[0.06] hover:text-white active:bg-white/10'
                        }`}
                      >
                        <span className="truncate">{item.name}</span>
                        {badge !== null && (
                          <span
                            title={`${badge} item${badge === 1 ? '' : 's'} need restocking`}
                            className="shrink-0 rounded bg-amber-500/20 px-1.5 text-[10px] font-semibold leading-4 tabular-nums text-amber-300"
                          >
                            {badge > 99 ? '99+' : badge}
                            <span className="sr-only"> need restocking</span>
                          </span>
                        )}
                      </Link>
                    </li>
                  )
                })}
              </ul>
            </div>
          )
        })}
      </nav>

      {/* Signed-in account. Not a link, so it has no hover state of its own;
          the sign-out button is the only control here. */}
      <div className="border-t border-white/[0.07] px-2 py-2">
        <div className="flex items-center gap-2.5 px-1.5 py-1">
          {profile ? (
            <>
              <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-[11px] font-semibold text-white">
                {profile.initials}
              </span>
              <div className="min-w-0 flex-1 leading-tight">
                <p className="truncate text-[13px] font-semibold text-white" title={profile.name}>{profile.name}</p>
                <p className="truncate text-[11px] text-slate-400">{profile.role}</p>
              </div>
            </>
          ) : (
            <>
              <span aria-hidden className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-white/10" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <span className="sr-only">Loading account</span>
                <span className="block h-3 w-24 animate-pulse rounded bg-white/10" />
                <span className="block h-2.5 w-12 animate-pulse rounded bg-white/10" />
              </div>
            </>
          )}
          <button
            type="button"
            onClick={handleLogout}
            disabled={signingOut}
            aria-label={signingOut ? 'Signing out' : 'Sign out'}
            title="Sign out"
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-400 transition-colors duration-150 hover:bg-white/[0.08] hover:text-white disabled:cursor-wait disabled:opacity-50 ${FOCUS_RING}`}
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
    </aside>
  )
}
