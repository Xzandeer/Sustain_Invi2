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
  const { isAdmin } = useUserRole()
  const visibleBottomItems = bottomItems.filter((item) => (item.href === '/users' ? isAdmin : true))

  const handleLogout = async () => {
    try {
      await signOut(auth)
      router.push('/login')
    } catch (error) {
      console.error('Logout failed', error)
    }
  }

  return (
    <aside className="h-screen w-64 bg-slate-100 border-r flex flex-col">
      <div className="flex-1">
        <div className="p-6 border-b">
          <h1 className="text-lg font-bold text-slate-900">JMGS JAPON SURPLUS</h1>
          <p className="text-sm text-gray-500">Sales & Inventory</p>
        </div>

        <div className="flex-1 p-4 space-y-2">
          <nav className="space-y-2">
            {navItems.map((item) => {
              const Icon = item.icon
              const active = pathname === item.href

              return (
                <Link
                  key={item.name}
                  href={item.href}
                  className={`flex items-center gap-3 px-4 py-3 rounded-lg cursor-pointer transition ${
                    active
                      ? 'bg-blue-900 text-white'
                      : 'text-gray-700 hover:bg-slate-200'
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

      <div className="p-4 border-t">
        {visibleBottomItems.map((item) => {
          const Icon = item.icon
          const active = pathname === item.href

          return (
            <Link
              key={item.name}
              href={item.href}
              className={`mb-2 flex items-center gap-3 rounded-lg px-4 py-3 transition last:mb-0 ${
                active
                  ? 'bg-blue-900 text-white'
                  : 'text-gray-700 hover:bg-slate-200'
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
          className="mb-2 flex w-full items-center gap-3 rounded-lg px-4 py-3 text-gray-700 transition last:mb-0 hover:bg-slate-200"
        >
          <LogOut className="h-5 w-5" />
          <span className="text-sm font-medium">Logout</span>
        </button>
      </div>
    </aside>
  )
}
