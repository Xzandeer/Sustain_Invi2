'use client'

import type { ReactNode } from 'react'

interface AnalyticsCardProps {
  title?: string
  subtitle?: string
  actions?: ReactNode
  children: ReactNode
  className?: string
  contentClassName?: string
}

export default function AnalyticsCard({
  title,
  subtitle,
  actions,
  children,
  className = '',
  contentClassName = '',
}: AnalyticsCardProps) {
  return (
    <section className={`rounded-2xl border border-slate-200 bg-white shadow-sm ${className}`.trim()}>
      {(title || subtitle || actions) && (
        <div className="flex flex-wrap items-center justify-between gap-3 p-4 pb-0">
          <div className="space-y-1">
            {title ? <h2 className="text-lg font-semibold text-slate-900">{title}</h2> : null}
            {subtitle ? <p className="text-sm text-gray-500">{subtitle}</p> : null}
          </div>
          {actions}
        </div>
      )}
      <div className={`p-4 ${contentClassName}`.trim()}>{children}</div>
    </section>
  )
}
