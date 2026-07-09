'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import {
  LayoutDashboard, BarChart3, ShoppingCart, Package,
  Package2, Trash2, Users, LogOut, Calendar,
  ClipboardList, UserCheck, Settings,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { onAuthStateChanged, signOut } from 'firebase/auth'
import { doc, getDoc } from 'firebase/firestore'
import { auth, db } from '@/lib/firebase'
import { useUserRole } from '@/hooks/useUserRole'

const mainNav = [
  { name: 'Dashboard',    href: '/dashboard',       icon: LayoutDashboard },
  { name: 'Sales',        href: '/sales',            icon: ShoppingCart },
  { name: 'Inventory',    href: '/inventory',        icon: Package },
  { name: 'Reservations', href: '/reservations',     icon: Calendar },
  { name: 'Customers',    href: '/customers',        icon: UserCheck },
  { name: 'Containers',   href: '/containers',       icon: Package2 },
]

const managementNav = [
  { name: 'Analytics',    href: '/analytics',        icon: BarChart3 },
  { name: 'Users',        href: '/users',            icon: Users },
]

const systemNav = [
  { name: 'Stock Logs',   href: '/inventory/logs',   icon: ClipboardList },
  { name: 'Trash',        href: '/inventory/trash',  icon: Trash2 },
]

export default function Sidebar() {
  const pathname = usePathname()
  const router   = useRouter()
  const { isAdmin, canViewStockLogs } = useUserRole()
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

  const NavItem = ({ item }: { item: { name: string; href: string; icon: React.ElementType } }) => {
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
          <p className="text-[13px] font-bold leading-tight text-white tracking-tight">JMGS JAPON</p>
          <p className="text-[10px] font-semibold tracking-widest text-blue-400">SURPLUS</p>
        </div>
      </div>

      {/* Nav */}
      <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-3 py-4">

        {/* MAIN */}
        <div>
          <p className="mb-1.5 px-3 text-[10px] font-bold uppercase tracking-widest text-gray-500">Main</p>
          <nav className="space-y-0.5">
            {mainNav.map(item => <NavItem key={item.href} item={item} />)}
          </nav>
        </div>

        {/* MANAGEMENT */}
        <div>
          <p className="mb-1.5 px-3 text-[10px] font-bold uppercase tracking-widest text-gray-500">Management</p>
          <nav className="space-y-0.5">
            {managementNav.map(item => (
              (!isAdmin && item.name === 'Users') ? null : <NavItem key={item.href + item.name} item={item} />
            ))}
          </nav>
        </div>

        {/* SYSTEM */}
        {(isAdmin || canViewStockLogs) && (
          <div>
            <p className="mb-1.5 px-3 text-[10px] font-bold uppercase tracking-widest text-gray-500">System</p>
            <nav className="space-y-0.5">
              {systemNav.map(item => <NavItem key={item.href} item={item} />)}
            </nav>
          </div>
        )}

        {/* ACCOUNT */}
        <div>
          <p className="mb-1.5 px-3 text-[10px] font-bold uppercase tracking-widest text-gray-500">Account</p>
          <nav className="space-y-0.5">
            <NavItem item={{ name: 'Settings', href: '/settings', icon: Settings }} />
          </nav>
        </div>
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
