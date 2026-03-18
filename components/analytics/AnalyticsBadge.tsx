'use client'

interface AnalyticsBadgeProps {
  children: string
  variant: 'low' | 'ok' | 'neutral'
}

export default function AnalyticsBadge({ children, variant }: AnalyticsBadgeProps) {
  const className =
    variant === 'low'
      ? 'bg-red-100 text-red-600'
      : variant === 'neutral'
        ? 'bg-slate-100 text-slate-600'
        : 'bg-green-100 text-green-600'

  return (
    <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${className}`}>
      {children}
    </span>
  )
}
