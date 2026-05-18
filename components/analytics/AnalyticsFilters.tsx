'use client'

import { useEffect, useState } from 'react'

export interface AnalyticsFilterValues {
  startDate: string
  endDate: string
  category: string
  condition: string
}

interface AnalyticsFiltersProps {
  values: AnalyticsFilterValues
  onChange: (values: AnalyticsFilterValues) => void
}

const categoryOptions = ['all', 'Electronics', 'Clothing', 'Home & Garden', 'Sports']
const conditionOptions = ['all', 'Brand New', 'Refurbished']

export default function AnalyticsFilters({ values, onChange }: AnalyticsFiltersProps) {
  const [startDate, setStartDate] = useState(values.startDate)
  const [endDate, setEndDate] = useState(values.endDate)
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
    setStartDate(values.startDate)
  }, [values.startDate])

  useEffect(() => {
    setEndDate(values.endDate)
  }, [values.endDate])

  useEffect(() => {
    if (!isInvalidRange(startDate, endDate)) return

    setEndDate(startDate)
    onChange({ ...values, endDate: startDate })
    setError('End date cannot be earlier than start date.')
  }, [endDate, onChange, startDate, values])

  const handleStartDateChange = (value: string) => {
    setStartDate(value)

    if (isInvalidRange(value, endDate)) {
      setEndDate(value)
      setError('')
      onChange({ ...values, startDate: value, endDate: value })
      return
    }

    validateDateRange(value, endDate)
    onChange({ ...values, startDate: value })
  }

  const handleEndDateChange = (value: string) => {
    if (!validateDateRange(startDate, value)) {
      if (startDate && value) {
        setEndDate(startDate)
        onChange({ ...values, endDate: startDate })
      }
      return
    }

    setEndDate(value)
    onChange({ ...values, endDate: value })
  }

  return (
    <section className="bg-white rounded-xl shadow-sm p-6 border space-y-4">
      <h2 className="text-xl font-semibold text-slate-900">Filters</h2>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">Start Date</label>
          <input
            type="date"
            value={startDate}
            max={endDate || undefined}
            onChange={(event) => handleStartDateChange(event.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-slate-500"
          />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">End Date</label>
          <input
            type="date"
            value={endDate}
            min={startDate || undefined}
            onChange={(event) => handleEndDateChange(event.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-slate-500"
          />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">Category</label>
          <select
            value={values.category}
            onChange={(event) => onChange({ ...values, category: event.target.value })}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-slate-500"
          >
            {categoryOptions.map((option) => (
              <option key={option} value={option}>
                {option === 'all' ? 'All Categories' : option}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">Condition</label>
          <select
            value={values.condition}
            onChange={(event) => onChange({ ...values, condition: event.target.value })}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-slate-500"
          >
            {conditionOptions.map((option) => (
              <option key={option} value={option}>
                {option === 'all' ? 'All Conditions' : option}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && <p className="mt-2 text-sm text-red-500">{error}</p>}
    </section>
  )
}
