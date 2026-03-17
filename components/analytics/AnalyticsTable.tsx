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
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200">
            {columns.map((column) => (
              <th
                key={column.header}
                className={`px-3 py-3 text-left text-sm font-medium text-gray-500 first:pl-0 last:pr-0 ${column.className ?? ''}`.trim()}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length > 0 ? (
            rows.map((row) => (
              <tr key={row.key} className="border-b border-slate-200 transition hover:bg-gray-50">
                {row.cells.map((cell, index) => (
                  <td key={`${row.key}-${index}`} className="px-3 py-2 text-sm text-slate-700 first:pl-0 last:pr-0">
                    {cell}
                  </td>
                ))}
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={columns.length} className="px-0 py-6 text-sm text-gray-500">
                {emptyMessage}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
