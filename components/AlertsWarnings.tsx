import { AlertTriangle, Info } from 'lucide-react'

interface AlertsWarningsProps {
  lowStockItems: string[]
  outOfStockCount: number
  loading?: boolean
}

interface AlertBoxProps {
  title: string
  description: string
  type: 'warning' | 'info'
}

function AlertBox({ title, description, type }: AlertBoxProps) {
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
          <p className="text-sm text-gray-600">{description}</p>
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
  const hasLowStockAlert = lowStockItems.length > 0
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
            lowStockItems.map((itemName) => (
              <AlertBox
                key={itemName}
                type="warning"
                title="Low Stock Category Alert"
                description={`Low stock alert for ${itemName}. Review inventory and restock as needed.`}
              />
            ))}

          {hasOutOfStockAlert && (
            <AlertBox
              type="info"
              title="Out of Stock Alert"
              description={`${outOfStockCount} ${outOfStockCount === 1 ? 'item is' : 'items are'} currently out of stock.`}
            />
          )}

          {!hasAnyAlerts && (
            <AlertBox
              type="info"
              title="System Stable"
              description="Inventory levels are currently healthy and no active alerts need attention."
            />
          )}
        </>
      )}
    </section>
  )
}
