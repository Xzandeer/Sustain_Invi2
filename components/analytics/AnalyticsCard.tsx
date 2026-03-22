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
    <section className={`rounded-2xl border border-slate-200/90 bg-white shadow-[0_10px_28px_rgba(59,76,117,0.08)] ${className}`.trim()}>
      {(title || subtitle || actions) && (
        <div className="flex flex-wrap items-center justify-between gap-2.5 p-3.5 pb-0">
          <div className="space-y-0.5">
            {title ? <h2 className="text-lg font-semibold text-slate-900">{title}</h2> : null}
            {subtitle ? <p className="text-xs text-slate-500">{subtitle}</p> : null}
          </div>
          {actions}
        </div>
      )}
      <div className={`p-3.5 ${contentClassName}`.trim()}>{children}</div>
    </section>
  )
}
