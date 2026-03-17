'use client'

import { useEffect, useState } from 'react'

interface SalesFiltersProps {
  search: string
  onSearchChange: (value: string) => void
  statusFilter: 'all' | 'completed' | 'voided'
  onStatusFilterChange: (value: 'all' | 'completed' | 'voided') => void
  startDate: string
  onStartDateChange: (value: string) => void
  endDate: string
  onEndDateChange: (value: string) => void
}

export default function SalesFilters({
  search,
  onSearchChange,
  statusFilter,
  onStatusFilterChange,
  startDate,
  onStartDateChange,
  endDate,
  onEndDateChange,
}: SalesFiltersProps) {
  const [localStartDate, setLocalStartDate] = useState(startDate)
  const [localEndDate, setLocalEndDate] = useState(endDate)
  const [error, setError] = useState('')

  useEffect(() => {
    setLocalStartDate(startDate)
  }, [startDate])

  useEffect(() => {
    setLocalEndDate(endDate)
  }, [endDate])

  const handleStartDateChange = (value: string) => {
    setLocalStartDate(value)
    onStartDateChange(value)

    if (localEndDate && value && new Date(value) > new Date(localEndDate)) {
      setLocalEndDate('')
      onEndDateChange('')
      setError('End date cannot be earlier than the start date.')
      return
    }

    setError('')
  }

  const handleEndDateChange = (value: string) => {
    if (localStartDate && value && new Date(value) < new Date(localStartDate)) {
      setError('End date cannot be earlier than the start date.')
      return
    }

    setError('')
    setLocalEndDate(value)
    onEndDateChange(value)
  }

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      <div className="md:col-span-2">
        <label className="mb-1 block text-sm font-medium text-slate-700">
          Search by Transaction ID or Customer
        </label>
        <input
          type="text"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Enter transaction ID or customer name..."
          className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-slate-500"
        />
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-slate-700">Start Date</label>
        <input
          type="date"
          value={localStartDate}
          onChange={(event) => handleStartDateChange(event.target.value)}
          className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-slate-500"
        />
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-slate-700">End Date</label>
        <input
          type="date"
          value={localEndDate}
          min={localStartDate || undefined}
          onChange={(event) => handleEndDateChange(event.target.value)}
          className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-slate-500"
        />
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-slate-700">Status</label>
        <select
          value={statusFilter}
          onChange={(event) =>
            onStatusFilterChange(event.target.value as 'all' | 'completed' | 'voided')
          }
          className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-slate-500"
        >
          <option value="all">All Transactions</option>
          <option value="completed">Completed</option>
          <option value="voided">Voided</option>
        </select>
      </div>

      {error && <p className="text-sm text-red-500 md:col-span-2 xl:col-span-4">{error}</p>}
    </div>
  )
}
