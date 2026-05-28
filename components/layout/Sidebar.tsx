'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import {
  LayoutDashboard,
  BarChart3,
  ShoppingCart,
  Package,
  Package2,
  Trash2,
  Users,
  LogOut,
  Calendar,
  ClipboardList,
  ChevronRight,
  UserCheck,
} from 'lucide-react'
import { useUserRole } from '@/hooks/useUserRole'
import { signOut } from 'firebase/auth'
import { auth } from '@/lib/firebase'

const navItems = [
  { name: 'Dashboard',    href: '/dashboard',       icon: LayoutDashboard },
  { name: 'Analytics',   href: '/analytics',        icon: BarChart3 },
  { name: 'Inventory',   href: '/inventory',        icon: Package },
  { name: 'Sales',       href: '/sales',            icon: ShoppingCart },
  { name: 'Reservations',href: '/reservations',     icon: Calendar },
  { name: 'Customers',    href: '/customers',        icon: UserCheck },
  { name: 'Containers',   href: '/containers',       icon: Package2 },
]

const adminItems = [
  { name: 'Trash',       href: '/inventory/trash',  icon: Trash2 },
]

const bottomItems = [
  { name: 'Users',       href: '/users',            icon: Users },
]

export default function Sidebar() {
  const pathname  = usePathname()
  const router    = useRouter()
  const { isAdmin, canViewStockLogs } = useUserRole()

  const stockLogItem = (isAdmin || canViewStockLogs)
    ? { name: 'Stock Logs', href: '/inventory/logs', icon: ClipboardList }
    : null

  const handleLogout = async () => {
    try {
      await signOut(auth)
      router.push('/login')
    } catch (err) {
      console.error('Logout failed', err)
    }
  }

  const isActive = (href: string) => pathname === href

  return (
    <aside className="flex h-screen w-48 flex-col bg-[#1e3a5f] shadow-xl">

      {/* ── Logo / Brand ── */}
      <div className="flex items-center gap-2.5 border-b border-white/5 px-4 py-4">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-blue-600/30 ring-1 ring-blue-500/30">
          <Package className="h-4 w-4 text-blue-300" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-[11px] font-bold leading-tight tracking-wide text-white">JMGS JAPON</p>
          <p className="text-[10px] font-medium tracking-widest text-blue-400/60">SURPLUS</p>
        </div>
      </div>

      {/* ── Main Nav ── */}
      <div className="flex flex-1 flex-col overflow-y-auto px-2.5 py-3">
        <nav className="space-y-0.5">
          {navItems.map((item) => {
            const Icon = item.icon
            const active = isActive(item.href)
            return (
              <Link
                key={item.href}
                href={item.href}
                className={
                  'group flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm font-medium transition-all duration-150 ' +
                  (active
                    ? 'bg-white text-blue-700 shadow-md'
                    : 'text-blue-200/70 hover:bg-white/8 hover:text-white')
                }
              >
                <Icon
                  className={
                    'h-4 w-4 shrink-0 transition-transform duration-150 group-hover:scale-110 ' +
                    (active ? 'text-blue-600' : 'text-blue-300/50 group-hover:text-white')
                  }
                />
                <span className="flex-1">{item.name}</span>
                {active && <ChevronRight className="h-3 w-3 text-blue-400" />}
              </Link>
            )
          })}
        </nav>

        {/* ── Admin section ── */}
        {(isAdmin || canViewStockLogs) && (
          <div className="mt-4">
            <p className="mb-1.5 px-3 text-[9px] font-semibold uppercase tracking-widest text-blue-400/40">
              Admin
            </p>
            <nav className="space-y-0.5">
              {isAdmin && adminItems.map((item) => {
                const Icon = item.icon
                const active = isActive(item.href)
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={
                      'group flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm font-medium transition-all duration-150 ' +
                      (active
                        ? 'bg-white text-blue-700 shadow-md'
                        : 'text-blue-200/70 hover:bg-white/8 hover:text-white')
                    }
                  >
                    <Icon
                      className={
                        'h-4 w-4 shrink-0 transition-transform duration-150 group-hover:scale-110 ' +
                        (active ? 'text-blue-600' : 'text-blue-300/50 group-hover:text-white')
                      }
                    />
                    <span className="flex-1">{item.name}</span>
                    {active && <ChevronRight className="h-3 w-3 text-blue-400" />}
                  </Link>
                )
              })}
              {stockLogItem && (() => {
                const Icon = stockLogItem.icon
                const active = isActive(stockLogItem.href)
                return (
                  <Link
                    href={stockLogItem.href}
                    className={
                      'group flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm font-medium transition-all duration-150 ' +
                      (active
                        ? 'bg-white text-blue-700 shadow-md'
                        : 'text-blue-200/70 hover:bg-white/8 hover:text-white')
                    }
                  >
                    <Icon
                      className={
                        'h-4 w-4 shrink-0 transition-transform duration-150 group-hover:scale-110 ' +
                        (active ? 'text-blue-600' : 'text-blue-300/50 group-hover:text-white')
                      }
                    />
                    <span className="flex-1">{stockLogItem.name}</span>
                    {active && <ChevronRight className="h-3 w-3 text-blue-400" />}
                  </Link>
                )
              })()}
            </nav>
          </div>
        )}
      </div>

      {/* ── Bottom: Users + Logout ── */}
      <div className="border-t border-white/5 px-2.5 py-3 space-y-0.5">
        {isAdmin && bottomItems.map((item) => {
          const Icon = item.icon
          const active = isActive(item.href)
          return (
            <Link
              key={item.href}
              href={item.href}
              className={
                'group flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm font-medium transition-all duration-150 ' +
                (active
                  ? 'bg-white text-blue-700 shadow-md'
                  : 'text-blue-200/70 hover:bg-white/8 hover:text-white')
              }
            >
              <Icon
                className={
                  'h-4 w-4 shrink-0 transition-transform duration-150 group-hover:scale-110 ' +
                  (active ? 'text-blue-600' : 'text-blue-300/50 group-hover:text-white')
                }
              />
              <span className="flex-1">{item.name}</span>
              {active && <ChevronRight className="h-3 w-3 text-blue-400" />}
            </Link>
          )
        })}

        <button
          type="button"
          onClick={handleLogout}
          className="group flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-sm font-medium text-blue-100 transition-all duration-150 hover:bg-red-500/20 hover:text-red-200"
        >
          <LogOut className="h-4 w-4 shrink-0 transition-transform duration-150 group-hover:scale-110 text-blue-300/50 group-hover:text-red-300" />
          <span className="flex-1">Logout</span>
        </button>
      </div>
    </aside>
  )
}
