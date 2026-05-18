interface KPICardProps {
  title: string
  value: string | number
  icon: string
  color: 'green' | 'blue' | 'yellow' | 'purple'
}

const colorClasses = {
  green: 'bg-green-50 dark:bg-green-900 text-green-700 dark:text-green-400',
  blue: 'bg-blue-50 dark:bg-blue-900 text-blue-700 dark:text-blue-400',
  yellow: 'bg-yellow-50 dark:bg-yellow-900 text-yellow-700 dark:text-yellow-400',
  purple: 'bg-purple-50 dark:bg-purple-900 text-purple-700 dark:text-purple-400',
}

export default function KPICard({ title, value, icon, color }: KPICardProps) {
  return (
    <div className={`rounded-lg p-6 ${colorClasses[color]}`}>
      <p className="text-sm font-medium mb-2 opacity-80">{title}</p>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-3xl font-bold">{value}</p>
        </div>
        <div className="text-4xl opacity-20">{icon}</div>
      </div>
    </div>
  )
}
