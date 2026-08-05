'use client'

// Filter bar for the sales history - date range, status and search.

import { useEffect, useState } from 'react'

interface SalesFiltersProps {
  search: string
  onSearchChange: (value: string) => void
  statusFilter: 'all' | 'completed' | 'voided'
  onStatusFilterChange: (value: 'all' | 'completed' | 'voided') => void
  categoryFilter: string
  onCategoryFilterChange: (value: string) => void
  categoryOptions: string[]
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
  categoryFilter,
  onCategoryFilterChange,
  categoryOptions,
  startDate,
  onStartDateChange,
  endDate,
  onEndDateChange,
}: SalesFiltersProps) {
  const [localStartDate, setLocalStartDate] = useState(startDate)
  const [localEndDate, setLocalEndDate] = useState(endDate)
  const [error, setError] = useState('')

  const isInvalidRange = (nextStartDate: string, nextEndDate: string) => {
    if (!nextStartDate || !nextEndDate) return false
    return new Date(nextEndDate) < new Date(nextStartDate)
  }

  const validateDateRange = (nextStartDate: string, nextEndDate: string) => {
    if (isInvalidRange(nextStartDate, nextEndDate)) {
      setError('End date cannot be earlier than start date.')
      return false
    }

    setError('')
    return true
  }

  useEffect(() => {
    setLocalStartDate(startDate)
  }, [startDate])

  useEffect(() => {
    setLocalEndDate(endDate)
  }, [endDate])

  useEffect(() => {
    if (!isInvalidRange(localStartDate, localEndDate)) return

    setLocalEndDate(localStartDate)
    onEndDateChange(localStartDate)
    setError('End date cannot be earlier than start date.')
  }, [localStartDate, localEndDate, onEndDateChange])

  const handleStartDateChange = (value: string) => {
    setLocalStartDate(value)

    if (isInvalidRange(value, localEndDate)) {
      setLocalEndDate(value)
      onStartDateChange(value)
      onEndDateChange(value)
      setError('')
      return
    }

    validateDateRange(value, localEndDate)
    onStartDateChange(value)
  }

  const handleEndDateChange = (value: string) => {
    if (!validateDateRange(localStartDate, value)) {
      if (localStartDate && value) {
        setLocalEndDate(localStartDate)
        onEndDateChange(localStartDate)
      }
      return
    }

    setLocalEndDate(value)
    onEndDateChange(value)
  }

  // Quick date ranges. Typing two dates for "this week" is the common case, so
  // these set both at once. The manual pickers stay for anything else.
  const applyPreset = (preset: 'today' | 'week' | 'month' | 'lastMonth' | 'year' | 'all') => {
    const now = new Date()
    const iso = (d: Date) => {
      const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000)
      return local.toISOString().slice(0, 10)
    }
    let from = ''
    let to = iso(now)

    if (preset === 'today') {
      from = iso(now)
    } else if (preset === 'week') {
      // Week starts Monday, which is how the shop counts a trading week
      const day = (now.getDay() + 6) % 7
      from = iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() - day))
    } else if (preset === 'month') {
      from = iso(new Date(now.getFullYear(), now.getMonth(), 1))
    } else if (preset === 'lastMonth') {
      from = iso(new Date(now.getFullYear(), now.getMonth() - 1, 1))
      to = iso(new Date(now.getFullYear(), now.getMonth(), 0))
    } else if (preset === 'year') {
      from = iso(new Date(now.getFullYear(), 0, 1))
    } else {
      from = ''
      to = ''
    }

    setError('')
    setLocalStartDate(from)
    setLocalEndDate(to)
    onStartDateChange(from)
    onEndDateChange(to)
  }

  const PRESETS = [
    { key: 'today', label: 'Today' },
    { key: 'week', label: 'This Week' },
    { key: 'month', label: 'This Month' },
    { key: 'lastMonth', label: 'Last Month' },
    { key: 'year', label: 'This Year' },
    { key: 'all', label: 'All Time' },
  ] as const

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
      <div className="md:col-span-2 xl:col-span-5">
        <label className="mb-1.5 block text-sm font-medium text-slate-700">Quick Range</label>
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => applyPreset(p.key)}
              className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:border-slate-500 hover:text-slate-900"
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="md:col-span-2 xl:col-span-2">
        <label className="mb-1 block text-sm font-medium text-slate-700">
          Search Sales Records
        </label>
        <input
          type="text"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Receipt number, customer, email, or item name"
          className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-slate-500"
        />
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-slate-700">Category</label>
        <select
          value={categoryFilter}
          onChange={(event) => onCategoryFilterChange(event.target.value)}
          className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-slate-500"
        >
          <option value="all">All Categories</option>
          {categoryOptions.map((category) => (
            <option key={category} value={category}>
              {category}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-slate-700">Start Date</label>
        <input
          type="date"
          value={localStartDate}
          max={localEndDate || undefined}
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

      {error && <p className="text-sm text-red-500 md:col-span-2 xl:col-span-5">{error}</p>}
    </div>
  )
}
