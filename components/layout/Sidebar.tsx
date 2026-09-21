'use client'

// Dashboard navigation.
//
// Links are filtered by the signed-in user's permissions, so staff only see
// the sections they are allowed to open. This is a convenience only - the
// real check happens in ProtectedRoute and again on the server.

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import {
  LayoutDashboard, BarChart3, ShoppingCart, Package,
  Trash2, Users, LogOut, Calendar,
  ClipboardList, Settings,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { onAuthStateChanged, signOut } from 'firebase/auth'
import { doc, getDoc } from 'firebase/firestore'
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
  icon: React.ElementType
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
      { name: 'Dashboard',    href: '/dashboard',   icon: LayoutDashboard },
      { name: 'Sales',        href: '/sales',       icon: ShoppingCart },
      { name: 'Inventory',    href: '/inventory',   icon: Package },
      {
        name: 'Reservations', href: '/reservations', icon: Calendar,
        show: (a) => a.isAdmin || a.can('canManageReservations'),
      },
      {
        name: 'Analytics',    href: '/analytics',   icon: BarChart3,
        show: (a) => a.isAdmin || a.can('canViewAnalytics'),
      },
    ],
  },
  {
    title: 'Records',
    items: [
      {
        name: 'Stock Logs',   href: '/inventory/logs',  icon: ClipboardList,
        show: (a) => a.isAdmin || a.canViewStockLogs,
      },
      {
        // Trash restores and permanently deletes items - admin only, matching
        // <ProtectedRoute requireAdmin> on the page itself.
        name: 'Trash',        href: '/inventory/trash', icon: Trash2,
        show: (a) => a.isAdmin,
      },
    ],
  },
  {
    title: 'Administration',
    items: [
      { name: 'Users',        href: '/users',       icon: Users, show: (a) => a.isAdmin },
    ],
  },
  {
    title: 'Account',
    items: [
      { name: 'Settings',     href: '/settings',    icon: Settings },
    ],
  },
]

export default function Sidebar() {
  const pathname = usePathname()
  const router   = useRouter()
  const { isAdmin, canViewStockLogs, can } = useUserRole()
  const [userName, setUserName]   = useState('User')
  const [userRole, setUserRole]   = useState('Staff')
  const [initials, setInitials]   = useState('U')

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) return
      try {
        const snap = await getDoc(doc(db, 'users', user.uid))
        if (snap.exists()) {
          const d = snap.data() as Record<string, unknown>
          const name = typeof d.name === 'string' && d.name.trim() ? d.name.trim()
            : typeof d.email === 'string' ? (d.email as string).split('@')[0] : 'User'
          const role = typeof d.role === 'string' ? d.role : 'Staff'
          setUserName(name)
          setUserRole(role.charAt(0).toUpperCase() + role.slice(1))
          setInitials(name.split(' ').map((n: string) => n[0]).join('').slice(0, 2).toUpperCase())
        }
      } catch (_) {}
    })
    return () => unsub()
  }, [])

  const handleLogout = async () => {
    try { await signOut(auth); router.push('/login') } catch (_) {}
  }

  const isActive = (href: string) =>
    href === '/dashboard' ? pathname === href : pathname.startsWith(href)

  const visibleSections = useMemo(() => {
    const access: NavAccess = { isAdmin, canViewStockLogs, can }
    return NAV_SECTIONS
      .map(section => ({
        ...section,
        items: section.items.filter(item => !item.show || item.show(access)),
      }))
      .filter(section => section.items.length > 0)
  }, [isAdmin, canViewStockLogs, can])

  const NavItem = ({ item }: { item: NavItemDef }) => {
    const Icon = item.icon
    const active = isActive(item.href)
    return (
      <Link href={item.href}
        className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all ${
          active
            ? 'bg-blue-600 text-white'
            : 'text-gray-400 hover:bg-white/5 hover:text-gray-100'
        }`}>
        <Icon className={`h-4 w-4 shrink-0 ${active ? 'text-white' : 'text-gray-500'}`} />
        <span className="flex-1 truncate">{item.name}</span>
      </Link>
    )
  }

  return (
    <aside className="flex h-screen w-56 flex-col bg-[#1a2035]">

      {/* Logo */}
      <div className="flex items-center gap-3 border-b border-white/5 px-5 py-4">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-linear-to-br from-blue-500 to-blue-600 shadow-sm">
          <Package className="h-4 w-4 text-white" />
        </div>
        <div className="min-w-0">
          <p className="text-[13px] font-bold leading-tight text-white tracking-tight">JMGs JAPAN</p>
          <p className="text-[10px] font-semibold tracking-widest text-blue-400">SURPLUS</p>
        </div>
      </div>

      {/* Nav */}
      <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-3 py-4">

        {/* A section renders only if the user can open something inside it.
            Previously the headings were hard-coded, so a staff member without
            analytics saw an "MANAGEMENT" label with nothing under it. */}
        {visibleSections.map(section => (
          <div key={section.title}>
            <p className="mb-1.5 px-3 text-[10px] font-bold uppercase tracking-widest text-gray-500">
              {section.title}
            </p>
            <nav className="space-y-0.5">
              {section.items.map(item => <NavItem key={item.href} item={item} />)}
            </nav>
          </div>
        ))}
      </div>

      {/* User profile */}
      <div className="border-t border-white/5 p-3">
        <div className="flex items-center gap-3 rounded-xl px-3 py-2.5 hover:bg-white/5 transition-colors cursor-default">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 text-xs font-bold text-white">
            {initials}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-white">{userName}</p>
            <p className="truncate text-[11px] text-gray-400">{userRole}</p>
          </div>
          <button onClick={handleLogout} title="Logout"
            className="shrink-0 rounded-lg p-1 text-gray-500 hover:bg-white/10 hover:text-white transition-colors">
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
    </aside>
  )
}
