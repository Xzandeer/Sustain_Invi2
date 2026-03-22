'use client'

import type { ReactNode } from 'react'

interface AnalyticsTableProps {
  columns: Array<{
    header: string
    className?: string
  }>
  rows: Array<{
    key: string
    cells: ReactNode[]
  }>
  emptyMessage?: string
}

export default function AnalyticsTable({
  columns,
  rows,
  emptyMessage = 'No data available.',
}: AnalyticsTableProps) {
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200/80 bg-slate-50/50">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-100/80">
            {columns.map((column) => (
              <th
                key={column.header}
                className={`px-2.5 py-2.5 text-left text-sm font-medium text-slate-600 first:pl-3 last:pr-3 ${column.className ?? ''}`.trim()}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length > 0 ? (
            rows.map((row) => (
              <tr key={row.key} className="border-b border-slate-200/80 bg-white transition hover:bg-slate-50/80">
                {row.cells.map((cell, index) => (
                  <td key={`${row.key}-${index}`} className="px-2.5 py-2 text-sm text-slate-700 first:pl-3 last:pr-3">
                    {cell}
                  </td>
                ))}
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={columns.length} className="px-3 py-6 text-sm text-slate-500">
                {emptyMessage}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
