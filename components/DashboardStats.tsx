import { AlertTriangle, Boxes, ShoppingBag, TrendingUp } from 'lucide-react'
import type { ComponentType } from 'react'

interface DashboardStatsProps {
  totalSales: string
  itemsSold: number
  productsInStock: number
  lowStockItems: number
  outOfStockItems: number
  loading?: boolean
}

interface StatCard {
  title: string
  value: string | number
  subtitle: string
  icon: ComponentType<{ className?: string }>
  danger?: boolean
}

function StatCard({ title, value, subtitle, icon: Icon, danger = false, loading = false }: StatCard & { loading?: boolean }) {
  return (
    <article
      className={`rounded-2xl border p-6 shadow-sm ${
        danger ? 'border-red-200 bg-red-50' : 'border-slate-200 bg-white'
      }`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-3">
          <p className="text-sm text-gray-500">{title}</p>
          {loading ? (
            <div className="space-y-2">
              <div className="h-8 w-28 animate-pulse rounded bg-slate-200" />
              <div className="h-4 w-24 animate-pulse rounded bg-slate-200" />
            </div>
          ) : (
            <>
              <p className={`text-2xl font-semibold ${danger ? 'text-red-600' : 'text-slate-900'}`}>{value}</p>
              <p className="text-sm text-gray-500">{subtitle}</p>
            </>
          )}
        </div>
        <div className={`rounded-xl p-2 ${danger ? 'bg-red-100 text-red-600' : 'bg-slate-100 text-slate-700'}`}>
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </article>
  )
}

export default function DashboardStats({
  totalSales,
  itemsSold,
  productsInStock,
  lowStockItems,
  outOfStockItems,
  loading = false,
}: DashboardStatsProps) {
  const cards: StatCard[] = [
    {
      title: 'Total Sales',
      value: totalSales,
      subtitle: 'Recorded revenue',
      icon: TrendingUp,
    },
    {
      title: 'Items Sold',
      value: itemsSold,
      subtitle: 'Units sold',
      icon: ShoppingBag,
    },
    {
      title: 'Products in Stock',
      value: productsInStock,
      subtitle: 'Current inventory',
      icon: Boxes,
    },
    {
      title: 'Low Stock Categories',
      value: lowStockItems,
      subtitle: lowStockItems > 0 ? 'Need attention' : 'Inventory healthy',
      icon: AlertTriangle,
      danger: lowStockItems > 0,
    },
  ]

  return (
    <section className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-4">
      {cards.map((card) => (
        <StatCard key={card.title} {...card} loading={loading} />
      ))}
    </section>
  )
}
