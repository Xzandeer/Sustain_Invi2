import { AlertTriangle, Info } from 'lucide-react'
import { useMemo } from 'react'
import type { LowStockItem } from '@/lib/server/salesInventoryMetrics'

interface AlertsWarningsProps {
  lowStockItems: LowStockItem[]
  outOfStockCount: number
  loading?: boolean
}

interface AlertBoxProps {
  title: string
  message: string
  type: 'warning' | 'info'
}

function AlertBox({ title, message, type }: AlertBoxProps) {
  const classes =
    type === 'warning'
      ? 'border-red-200 bg-red-50'
      : 'border-blue-200 bg-blue-50'

  const iconClasses = type === 'warning' ? 'text-red-600' : 'text-blue-600'
  const Icon = type === 'warning' ? AlertTriangle : Info

  return (
    <article className={`rounded-xl border p-4 ${classes}`}>
      <div className="flex items-start gap-3">
        <Icon className={`mt-0.5 h-5 w-5 ${iconClasses}`} />
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
          <p className="text-sm text-gray-600">{message}</p>
        </div>
      </div>
    </article>
  )
}

export default function AlertsWarnings({
  lowStockItems,
  outOfStockCount,
  loading = false,
}: AlertsWarningsProps) {
  const groupedLowStockItems = useMemo(() => {
    const categories = new Map<
      string,
      {
        id: string
        categoryName: string
        count: number
        items: LowStockItem[]
      }
    >()

    lowStockItems.forEach((item, index) => {
      const key = item.categoryName || 'Uncategorized'
      const current = categories.get(key) ?? {
        id: item.id || `${key}-${index}`,
        categoryName: key,
        count: 0,
        items: [],
      }

      current.count += 1
      current.items.push(item)
      categories.set(key, current)
    })

    return Array.from(categories.values())
      .sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count
        return a.categoryName.localeCompare(b.categoryName)
      })
      .slice(0, 5)
  }, [lowStockItems])

  const hasLowStockAlert = groupedLowStockItems.length > 0
  const hasOutOfStockAlert = outOfStockCount > 0
  const hasAnyAlerts = hasLowStockAlert || hasOutOfStockAlert

  return (
    <section className="space-y-4">
      <h2 className="text-2xl font-bold text-slate-900">Alerts & Warnings</h2>

      {loading ? (
        <div className="space-y-3">
          <div className="h-20 animate-pulse rounded-xl bg-slate-200" />
          <div className="h-20 animate-pulse rounded-xl bg-slate-200" />
        </div>
      ) : (
        <>
          {hasLowStockAlert &&
            groupedLowStockItems.map((item, index) => (
              <AlertBox
                key={`${item.id}-${index}`}
                type="warning"
                title="Low Stock Alert"
                message={`${item.categoryName} has ${item.count} low stock item${item.count === 1 ? '' : 's'}.`}
              />
            ))}

          {hasOutOfStockAlert && (
            <AlertBox
              type="info"
              title="Out of Stock Alert"
              message={`${outOfStockCount} ${outOfStockCount === 1 ? 'item is' : 'items are'} currently out of stock.`}
            />
          )}

          {!hasAnyAlerts && (
            <AlertBox
              type="info"
              title="All Clear"
              message="All inventory levels are healthy."
            />
          )}
        </>
      )}
    </section>
  )
}
