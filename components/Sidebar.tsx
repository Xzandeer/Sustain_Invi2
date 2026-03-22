'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import {
  LayoutDashboard,
  BarChart3,
  ShoppingCart,
  Package,
  Trash2,
  Users,
  LogOut,
  Calendar,
} from 'lucide-react'
import { useUserRole } from '@/hooks/useUserRole'
import { signOut } from 'firebase/auth'
import { auth } from '@/lib/firebase'

const navItems = [
  { name: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { name: 'Analytics', href: '/analytics', icon: BarChart3 },
  { name: 'Inventory', href: '/inventory', icon: Package },
  { name: 'Sales', href: '/sales', icon: ShoppingCart },
  { name: 'Reservations', href: '/reservations', icon: Calendar },
  { name: 'Trash', href: '/inventory/trash', icon: Trash2 },
]

const bottomItems = [
  { name: 'Users', href: '/users', icon: Users },
]

export default function Sidebar() {
  const pathname = usePathname()
  const router = useRouter()
  const { isAdmin, canViewStockLogs } = useUserRole()
  const visibleBottomItems = bottomItems.filter((item) => (item.href === '/users' ? isAdmin : true))
  const visibleNavItems = navItems.filter((item) => {
    if (item.href === '/inventory/trash') return isAdmin
    return true
  })

  const inventoryExtras = [
    isAdmin || canViewStockLogs
      ? { name: 'Stock Logs', href: '/inventory/logs', icon: Package }
      : null,
  ].filter((item): item is { name: string; href: string; icon: typeof Package } => item !== null)

  const handleLogout = async () => {
    try {
      await signOut(auth)
      router.push('/login')
    } catch (error) {
      console.error('Logout failed', error)
    }
  }

  return (
    <aside className="flex h-screen w-48 flex-col border-r border-slate-200/90 bg-[color:var(--sidebar)]">
      <div className="flex-1">
        <div className="border-b border-slate-200/90 px-3.5 py-3.5">
          <h1 className="text-[0.95rem] font-bold tracking-[0.02em] text-[color:var(--sidebar-foreground)]">JMGS JAPON SURPLUS</h1>
        </div>

        <div className="flex-1 p-2">
          <nav className="space-y-1">
            {visibleNavItems.map((item) => {
              const Icon = item.icon
              const active = pathname === item.href

              return (
                <Link
                  key={item.name}
                  href={item.href}
                  className={`flex items-center gap-2.5 rounded-lg px-2.5 py-1.75 transition ${
                    active
                      ? 'bg-[color:var(--sidebar-primary)] text-[color:var(--sidebar-primary-foreground)] shadow-sm'
                      : 'text-slate-700 hover:bg-sky-50 hover:text-slate-900'
                  }`}
                >
                  <Icon className="h-5 w-5" />
                  <span className="text-sm font-medium">{item.name}</span>
                </Link>
              )
            })}
            {inventoryExtras.map((item) => {
              const Icon = item.icon
              const active = pathname === item.href

              return (
                <Link
                  key={item.name}
                  href={item.href}
                  className={`flex items-center gap-2.5 rounded-lg px-2.5 py-1.75 transition ${
                    active
                      ? 'bg-[color:var(--sidebar-primary)] text-[color:var(--sidebar-primary-foreground)] shadow-sm'
                      : 'text-slate-700 hover:bg-sky-50 hover:text-slate-900'
                  }`}
                >
                  <Icon className="h-5 w-5" />
                  <span className="text-sm font-medium">{item.name}</span>
                </Link>
              )
            })}
          </nav>
        </div>
      </div>

      <div className="border-t border-slate-200/90 p-2">
        {visibleBottomItems.map((item) => {
          const Icon = item.icon
          const active = pathname === item.href

          return (
            <Link
              key={item.name}
              href={item.href}
              className={`mb-2 flex items-center gap-2.5 rounded-lg px-2.5 py-1.75 transition last:mb-0 ${
                active
                  ? 'bg-[color:var(--sidebar-primary)] text-[color:var(--sidebar-primary-foreground)] shadow-sm'
                  : 'text-slate-700 hover:bg-sky-50 hover:text-slate-900'
              }`}
            >
              <Icon className="h-5 w-5" />
              <span className="text-sm font-medium">{item.name}</span>
            </Link>
          )
        })}

        <button
          type="button"
          onClick={handleLogout}
          className="mb-2 flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.75 text-slate-700 transition last:mb-0 hover:bg-sky-50 hover:text-slate-900"
        >
          <LogOut className="h-5 w-5" />
          <span className="text-sm font-medium">Logout</span>
        </button>
      </div>
    </aside>
  )
}
