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
      className={`rounded-2xl border p-5 shadow-sm ${
        danger
          ? 'border-rose-200 bg-rose-50/90 shadow-[0_10px_24px_rgba(190,24,93,0.08)]'
          : 'border-slate-200/90 bg-white shadow-[0_10px_24px_rgba(59,76,117,0.08)]'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-2.5">
          <p className="text-xs uppercase tracking-[0.08em] text-slate-500">{title}</p>
          {loading ? (
              <div className="space-y-2">
              <div className="h-8 w-28 animate-pulse rounded bg-slate-200" />
              <div className="h-4 w-24 animate-pulse rounded bg-slate-200" />
              </div>
          ) : (
            <>
              <p className={`text-[1.65rem] font-semibold ${danger ? 'text-rose-700' : 'text-slate-900'}`}>{value}</p>
              <p className="text-xs text-slate-500">{subtitle}</p>
            </>
          )}
        </div>
        <div className={`rounded-xl p-2 ${danger ? 'bg-rose-100 text-rose-700' : 'bg-[color:var(--accent)] text-[color:var(--primary)]'}`}>
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
    <section className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
      {cards.map((card) => (
        <StatCard key={card.title} {...card} loading={loading} />
      ))}
    </section>
  )
}
