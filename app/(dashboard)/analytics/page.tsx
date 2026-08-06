'use client'

// Analytics page - business intelligence over sales, inventory and reservations.
//
// Everything on this page is computed in the browser from a single read of four
// collections (categories, sales, inventory, reservations). The only server
// call is the AI forecast, fetched from /api/forecast/ai-enhanced.
//
// How to read this file, top to bottom:
//   1. Types            - the shapes of the records and rows used below
//   2. Formatting       - peso, percent and number formatters
//   3. Date helpers     - start/end of day, week, month, year and date math
//   4. Comparison       - percent change vs. previous period and last year
//   5. Range presets    - turns "this month" etc. into a real start/end pair
//   6. Series builders  - trend line, forecast line, per-category forecast
//   7. Summarizers      - totals, top sellers, category performance
//   8. AnalyticsContent - the component; all state and rendering lives here
//
// Debugging tip: if a number on screen looks wrong, it is almost always a date
// range problem, not a math problem. Check getPresetRange() and inRange() first.

import { useEffect, useMemo, useState } from 'react'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  ArcElement,
  Tooltip,
  Legend,
} from 'chart.js'
import { Line, Doughnut } from 'react-chartjs-2'
import { collection, getDocs } from 'firebase/firestore'
import ProtectedRoute from '@/components/shared/ProtectedRoute'
import { db } from '@/lib/firebase'
import AnalyticsTable from '@/components/analytics/AnalyticsTable'
import type { InventoryRecord } from '@/lib/server/salesInventoryMetrics'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, ArcElement, Tooltip, Legend)

// ── 1. Types ──────────────────────────────────────────────────────────────────
type SaleItemCondition = 'New' | 'Refurbished'
type AnalyticsModalType = 'top' | null
type TimeRangePreset = 'this-week' | 'this-month' | 'last-month' | 'last-6-months' | 'this-year' | 'custom'

interface AIForecastDay {
  day: string
  date: string
  weighted: number
  ai: number
  delta: number
}

interface AIForecastData {
  success: boolean
  canForecast: boolean
  reason?: string
  baseForecast?: {
    forecast: Array<{ day: string; date: string; weighted: number }>
    avgDailyRevenue: number
    trendPct: number
    trendDirection: string
    dataPoints: number
  }
  aiForecast?: {
    forecast: AIForecastDay[]
    insight: string
    confidence: string
    fromCache: boolean
    warning?: string
  }
  summary?: {
    wowChange: number
    last7Revenue: number
    prior7Revenue: number
    topCategories: Array<{ name: string; revenue: number; units: number }>
    totalDaysWithData: number
    dataStart: string
    dataEnd: string
  }
  generatedAt?: string
  fromCache?: boolean
}

interface SaleRecord {
  id: string
  items: Array<{
    name: string
    quantity: number
    price: number
    categoryId: string
    condition: SaleItemCondition
  }>
  totalAmount: number
  createdAt: Date | null
}

interface CategoryPerformanceRow {
  categoryId: string
  categoryName: string
  itemsSold: number
  revenue: number
}

interface ComparisonMetric {
  label: string
  value: number
  change: number | null
}

interface TrendPoint {
  date: Date
  label: string
  total: number
}

interface CategoryForecastRow {
  categoryId: string
  categoryName: string
  projectedRevenue: number
  projectedItemsSold: number
}

// Tracks reservation status counts for the Reservation Activity panel
interface ReservationRecord {
  id: string
  status: 'Active' | 'Completed' | 'Cancelled' | 'Expired'
  createdAt: Date | null
}

// Color map for each reservation status used in the donut chart and legend
const RESERVATION_STATUS_COLORS: Record<ReservationRecord['status'], string> = {
  Active: '#3b82f6',
  Completed: '#22c55e',
  Cancelled: '#ef4444',
  Expired: '#94a3b8',
}

const toNumber = (value: unknown, fallback = 0) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

const toDate = (value: unknown): Date | null => {
  if (!value) return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? null : parsed
  }
  if (typeof value === 'object') {
    const timestamp = value as { toDate?: () => Date; seconds?: number; nanoseconds?: number }
    if (typeof timestamp.toDate === 'function') {
      const parsed = timestamp.toDate()
      return Number.isNaN(parsed.getTime()) ? null : parsed
    }
    if (typeof timestamp.seconds === 'number') {
      const millis = timestamp.seconds * 1000 + Math.floor((timestamp.nanoseconds ?? 0) / 1_000_000)
      const parsed = new Date(millis)
      return Number.isNaN(parsed.getTime()) ? null : parsed
    }
  }
  return null
}

// ── 2. Formatting helpers ─────────────────────────────────────────────────────
const currency = (value: number) =>
  value.toLocaleString('en-PH', {
    style: 'currency',
    currency: 'PHP',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })

const percentFormatter = new Intl.NumberFormat('en-PH', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})

const compactNumber = new Intl.NumberFormat('en-PH')

// ── 3. Date helpers ───────────────────────────────────────────────────────────
const startOfDay = (date: Date) => {
  const next = new Date(date)
  next.setHours(0, 0, 0, 0)
  return next
}

const endOfDay = (date: Date) => {
  const next = new Date(date)
  next.setHours(23, 59, 59, 999)
  return next
}

const startOfWeek = (date: Date) => {
  const next = startOfDay(date)
  const day = next.getDay()
  const diff = day === 0 ? -6 : 1 - day
  next.setDate(next.getDate() + diff)
  return next
}

const startOfMonth = (date: Date) => new Date(date.getFullYear(), date.getMonth(), 1)
const endOfMonth = (date: Date) => new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999)
const startOfYear = (date: Date) => new Date(date.getFullYear(), 0, 1)

const addMonths = (date: Date, months: number) => {
  const next = new Date(date)
  next.setMonth(next.getMonth() + months)
  return next
}

const addYears = (date: Date, years: number) => {
  const next = new Date(date)
  next.setFullYear(next.getFullYear() + years)
  return next
}

const addDays = (date: Date, days: number) => {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

const formatDateInput = (date: Date) => {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

const parseDateInput = (value: string) => {
  if (!value) return null
  const parsed = new Date(`${value}T00:00:00`)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

const formatMonthLabel = (date: Date) =>
  date.toLocaleDateString('en-PH', {
    month: 'short',
    year: 'numeric',
  })

const formatDayLabel = (date: Date) =>
  date.toLocaleDateString('en-PH', {
    month: 'short',
    day: 'numeric',
  })

const getMonthKey = (date: Date) => `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, '0')}`
const getDayKey = (date: Date) => formatDateInput(date)

const getRangeLabel = (preset: TimeRangePreset) => {
  switch (preset) {
    case 'this-week':
      return 'This Week'
    case 'this-month':
      return 'This Month'
    case 'last-month':
      return 'Last Month'
    case 'last-6-months':
      return 'Last 6 Months'
    case 'this-year':
      return 'This Year'
    case 'custom':
      return 'Custom Range'
    default:
      return 'This Month'
  }
}

// ── 4. Period comparison ──────────────────────────────────────────────────────
const calculatePercentChange = (current: number, previous: number) => {
  if (previous === 0) {
    if (current === 0) return 0
    return null
  }
  return ((current - previous) / previous) * 100
}

const getChangeVariant = (change: number | null) => {
  if (change === null) return 'neutral'
  if (change > 0) return 'ok'
  if (change < 0) return 'low'
  return 'neutral'
}

const getComparisonText = (change: number | null) => {
  if (change === null) return 'No prior baseline'
  if (change === 0) return 'No change'
  const direction = change > 0 ? 'increase' : 'decrease'
  return `${percentFormatter.format(Math.abs(change))}% ${direction}`
}

const formatPeso = (value: number) =>
  `₱${value.toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`

// ── 5. Range presets ──────────────────────────────────────────────────────────
const getPresetRange = (preset: TimeRangePreset, referenceDate: Date) => {
  const baseDate = startOfDay(referenceDate)

  switch (preset) {
    case 'this-week':
      return { start: startOfWeek(baseDate), end: endOfDay(baseDate) }
    case 'this-month':
      return { start: startOfMonth(baseDate), end: endOfDay(baseDate) }
    case 'last-month': {
      const previousMonth = addMonths(baseDate, -1)
      return { start: startOfMonth(previousMonth), end: endOfMonth(previousMonth) }
    }
    case 'last-6-months':
      return { start: startOfMonth(addMonths(baseDate, -5)), end: endOfDay(baseDate) }
    case 'this-year':
      return { start: startOfYear(baseDate), end: endOfDay(baseDate) }
    case 'custom':
      return { start: startOfMonth(baseDate), end: endOfDay(baseDate) }
    default:
      return { start: startOfMonth(baseDate), end: endOfDay(baseDate) }
  }
}

const getPreviousPeriodRange = (start: Date, end: Date) => {
  const duration = end.getTime() - start.getTime()
  const previousEnd = new Date(start.getTime() - 1)
  const previousStart = new Date(previousEnd.getTime() - duration)
  return {
    start: startOfDay(previousStart),
    end: endOfDay(previousEnd),
  }
}

const getSamePeriodLastYearRange = (start: Date, end: Date) => ({
  start: startOfDay(addYears(start, -1)),
  end: endOfDay(addYears(end, -1)),
})

const inRange = (date: Date | null, start: Date, end: Date) => {
  if (!date) return false
  return date >= start && date <= end
}

// ── 6. Chart series builders ──────────────────────────────────────────────────
const buildTrendSeries = (sales: SaleRecord[], start: Date, end: Date) => {
  const diffDays = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)))
  const useDailyGrouping = diffDays <= 31
  const grouped = new Map<string, TrendPoint>()

  if (useDailyGrouping) {
    const cursor = startOfDay(start)
    const rangeEnd = endOfDay(end)

    while (cursor <= rangeEnd) {
      const currentDate = new Date(cursor)
      const key = getDayKey(currentDate)
      grouped.set(key, {
        date: currentDate,
        label: formatDayLabel(currentDate),
        total: 0,
      })
      cursor.setDate(cursor.getDate() + 1)
    }
  } else {
    const cursor = new Date(start.getFullYear(), start.getMonth(), 1)
    const rangeEnd = new Date(end.getFullYear(), end.getMonth(), 1)

    while (cursor <= rangeEnd) {
      const currentDate = new Date(cursor)
      const key = getMonthKey(currentDate)
      grouped.set(key, {
        date: currentDate,
        label: formatMonthLabel(currentDate),
        total: 0,
      })
      cursor.setMonth(cursor.getMonth() + 1)
    }
  }

  sales.forEach((sale) => {
    if (!sale.createdAt || !inRange(sale.createdAt, start, end)) return

    const key = useDailyGrouping ? getDayKey(sale.createdAt) : getMonthKey(sale.createdAt)
    const current = grouped.get(key)
    if (!current) return
    current.total += sale.totalAmount
  })

  const rows = Array.from(grouped.values()).sort((a, b) => a.date.getTime() - b.date.getTime())

  return {
    labels: rows.map((row) => row.label),
    values: rows.map((row) => row.total),
    rows,
    granularity: (useDailyGrouping ? 'day' : 'month') as 'day' | 'month',
    hasSinglePoint: rows.filter((row) => row.total > 0).length <= 1,
  }
}

const buildForecastSeries = (
  rows: TrendPoint[],
  granularity: 'day' | 'month'
) => {
  if (rows.length === 0) {
    return {
      labels: [] as string[],
      actualValues: [] as Array<number | null>,
      forecastValues: [] as Array<number | null>,
      projectedTotal: 0,
      trailingWindow: 0,
      steps: 0,
      note: 'Forecast becomes available after sales history is recorded for the selected range.',
    }
  }

  const steps = granularity === 'day' ? 7 : 1
  const trailingWindow = Math.min(granularity === 'day' ? 7 : 3, rows.length)
  const trailingRows = rows.slice(-trailingWindow)
  const weightedMovingAverage =
    trailingRows.reduce((sum, row, index) => sum + row.total * (index + 1), 0) /
    Math.max(1, trailingRows.reduce((sum, _, index) => sum + index + 1, 0))
  const splitIndex = Math.max(1, Math.floor(trailingRows.length / 2))
  const earlierRows = trailingRows.slice(0, splitIndex)
  const recentRows = trailingRows.slice(splitIndex)
  const earlierAverage =
    earlierRows.reduce((sum, row) => sum + row.total, 0) / Math.max(1, earlierRows.length)
  const recentAverage =
    recentRows.reduce((sum, row) => sum + row.total, 0) / Math.max(1, recentRows.length)
  const trendAdjustment = recentAverage - earlierAverage
  const projectedPointValue = Math.max(0, weightedMovingAverage + trendAdjustment * 0.35)
  const lastActualValue = rows[rows.length - 1]?.total ?? 0

  const forecastRows = Array.from({ length: steps }, (_, index) => {
    const lastDate = rows[rows.length - 1]?.date ?? new Date()
    const date =
      granularity === 'day'
        ? startOfDay(addDays(lastDate, index + 1))
        : new Date(lastDate.getFullYear(), lastDate.getMonth() + index + 1, 1)

    return {
      date,
      label: granularity === 'day' ? formatDayLabel(date) : formatMonthLabel(date),
      total: projectedPointValue,
    }
  })

  return {
    labels: [...rows.map((row) => row.label), ...forecastRows.map((row) => row.label)],
    actualValues: [...rows.map((row) => row.total), ...Array(forecastRows.length).fill(null)],
    forecastValues: [
      ...Array(Math.max(0, rows.length - 1)).fill(null),
      lastActualValue,
      ...forecastRows.map((row) => row.total),
    ],
    projectedTotal: forecastRows.reduce((sum, row) => sum + row.total, 0),
    trailingWindow,
    steps,
    note:
      granularity === 'day'
        ? `Forecast: weighted ${trailingWindow}-day average`
        : `Forecast: weighted ${trailingWindow}-period average`,
  }
}

const buildCategoryForecast = (
  sales: SaleRecord[],
  start: Date,
  end: Date,
  categoryNameMap: Record<string, string>,
  granularity: 'day' | 'month'
) => {
  const diffDays = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)))
  const useDailyGrouping = granularity === 'day' && diffDays <= 31
  const groupedDates: Date[] = []

  if (useDailyGrouping) {
    const cursor = startOfDay(start)
    const rangeEnd = endOfDay(end)
    while (cursor <= rangeEnd) {
      groupedDates.push(new Date(cursor))
      cursor.setDate(cursor.getDate() + 1)
    }
  } else {
    const cursor = new Date(start.getFullYear(), start.getMonth(), 1)
    const rangeEnd = new Date(end.getFullYear(), end.getMonth(), 1)
    while (cursor <= rangeEnd) {
      groupedDates.push(new Date(cursor))
      cursor.setMonth(cursor.getMonth() + 1)
    }
  }

  const categoryBuckets = new Map<string, { categoryName: string; revenue: number[]; items: number[] }>()
  const keyByDate = (date: Date) => (useDailyGrouping ? getDayKey(date) : getMonthKey(date))
  const bucketIndexByKey = new Map(groupedDates.map((date, index) => [keyByDate(date), index]))

  sales.forEach((sale) => {
    if (!sale.createdAt || !inRange(sale.createdAt, start, end)) return
    const bucketIndex = bucketIndexByKey.get(keyByDate(sale.createdAt))
    if (bucketIndex == null) return

    sale.items.forEach((item) => {
      const categoryId = item.categoryId || 'uncategorized'
      const current =
        categoryBuckets.get(categoryId) ?? {
          categoryName: categoryNameMap[categoryId] ?? 'Uncategorized',
          revenue: Array(groupedDates.length).fill(0),
          items: Array(groupedDates.length).fill(0),
        }

      current.revenue[bucketIndex] += item.quantity * item.price
      current.items[bucketIndex] += item.quantity
      categoryBuckets.set(categoryId, current)
    })
  })

  const trailingWindow = Math.min(useDailyGrouping ? 7 : 3, Math.max(1, groupedDates.length))
  const steps = useDailyGrouping ? 7 : 1

  const rows = Array.from(categoryBuckets.entries())
    .map(([categoryId, value]) => {
      const recentRevenue = value.revenue.slice(-trailingWindow)
      const recentItems = value.items.slice(-trailingWindow)
      const weightedRevenueAverage =
        recentRevenue.reduce((sum, current, index) => sum + current * (index + 1), 0) /
        Math.max(1, recentRevenue.reduce((sum, _, index) => sum + index + 1, 0))
      const weightedItemsAverage =
        recentItems.reduce((sum, current, index) => sum + current * (index + 1), 0) /
        Math.max(1, recentItems.reduce((sum, _, index) => sum + index + 1, 0))
      const splitIndex = Math.max(1, Math.floor(recentRevenue.length / 2))
      const earlierRevenue = recentRevenue.slice(0, splitIndex)
      const laterRevenue = recentRevenue.slice(splitIndex)
      const earlierItems = recentItems.slice(0, splitIndex)
      const laterItems = recentItems.slice(splitIndex)
      const revenueTrend =
        laterRevenue.reduce((sum, current) => sum + current, 0) / Math.max(1, laterRevenue.length) -
        earlierRevenue.reduce((sum, current) => sum + current, 0) / Math.max(1, earlierRevenue.length)
      const itemsTrend =
        laterItems.reduce((sum, current) => sum + current, 0) / Math.max(1, laterItems.length) -
        earlierItems.reduce((sum, current) => sum + current, 0) / Math.max(1, earlierItems.length)
      const projectedRevenuePerStep = Math.max(0, weightedRevenueAverage + revenueTrend * 0.35)
      const projectedItemsPerStep = Math.max(0, weightedItemsAverage + itemsTrend * 0.35)

      return {
        categoryId,
        categoryName: value.categoryName,
        projectedRevenue: projectedRevenuePerStep * steps,
        projectedItemsSold: projectedItemsPerStep * steps,
      } satisfies CategoryForecastRow
    })
    .filter((row) => row.projectedRevenue > 0 || row.projectedItemsSold > 0)
    .sort((a, b) => {
      if (b.projectedRevenue !== a.projectedRevenue) return b.projectedRevenue - a.projectedRevenue
      return b.projectedItemsSold - a.projectedItemsSold
    })

  return {
    rows,
    topCategory: rows[0] ?? null,
    trailingWindow,
    steps,
  }
}

// ── 7. Summarizers ────────────────────────────────────────────────────────────
const summarizeSales = (sales: SaleRecord[], categoryNameMap: Record<string, string>) => {
  const categoryMap = new Map<string, CategoryPerformanceRow>()
  let totalSales = 0
  let itemsSold = 0

  sales.forEach((sale) => {
    totalSales += sale.totalAmount

    sale.items.forEach((item) => {
      const quantity = Number(item.quantity ?? 0)
      const revenue = Number(item.quantity ?? 0) * Number(item.price ?? 0)
      const categoryId = item.categoryId || 'uncategorized'
      const categoryName = categoryNameMap[categoryId] ?? 'Uncategorized'

      itemsSold += quantity

      const current = categoryMap.get(categoryId) ?? {
        categoryId,
        categoryName,
        itemsSold: 0,
        revenue: 0,
      }

      current.itemsSold += quantity
      current.revenue += revenue
      categoryMap.set(categoryId, current)
    })
  })

  const categories = Array.from(categoryMap.values()).sort((a, b) => {
    if (b.revenue !== a.revenue) return b.revenue - a.revenue
    return b.itemsSold - a.itemsSold
  })

  return {
    totalSales,
    itemsSold,
    topCategory: categories[0] ?? null,
    categories,
  }
}

const generateSummary = ({
  timeRangeLabel,
  totalSales,
  itemsSold,
  topCategory,
  salesChangePercent,
  topCategoryRevenue,
}: {
  timeRangeLabel: string
  totalSales: number
  itemsSold: number
  topCategory: string | null
  salesChangePercent: number | null
  topCategoryRevenue: number
}) => {
  const firstSentence =
    salesChangePercent === null
      ? `Sales for ${timeRangeLabel.toLowerCase()} reached ${formatPeso(totalSales)}. No prior comparison data available.`
      : `Sales for ${timeRangeLabel.toLowerCase()} reached ${formatPeso(totalSales)}, showing a ${percentFormatter.format(Math.abs(salesChangePercent))}% ${salesChangePercent > 0 ? 'increase' : salesChangePercent < 0 ? 'decrease' : 'change'} compared to the last period.`

  const secondSentence = topCategory
    ? `${topCategory} was the top-performing category with ${formatPeso(topCategoryRevenue)} in revenue. A total of ${compactNumber.format(itemsSold)} items were sold.`
    : `A total of ${compactNumber.format(itemsSold)} items were sold.`

  return `${firstSentence} ${secondSentence}`.trim()
}

// ── 8. Page component ─────────────────────────────────────────────────────────
export default function AnalyticsPage() {
  return (
    <ProtectedRoute requirePermission="canViewAnalytics">
      <AnalyticsContent />
    </ProtectedRoute>
  )
}

function AnalyticsContent() {
  // ── State: raw data, active filters, forecast status ──────────────────────
  const [sales, setSales] = useState<SaleRecord[]>([])
  const [inventory, setInventory] = useState<InventoryRecord[]>([])
  const [categories, setCategories] = useState<Array<{ id: string; name: string }>>([])
  const [reservations, setReservations] = useState<ReservationRecord[]>([])
  const [timeRangePreset, setTimeRangePreset] = useState<TimeRangePreset>('this-month')
  const [customStartDate, setCustomStartDate] = useState('')
  const [customEndDate, setCustomEndDate] = useState('')
  const [dateRangeError, setDateRangeError] = useState('')
  const [selectedCategory, setSelectedCategory] = useState<string>('All Categories')
  const [selectedCondition, setSelectedCondition] = useState<SaleItemCondition | 'All Conditions'>('All Conditions')
  const [openModal, setOpenModal] = useState<AnalyticsModalType>(null)
  const [aiForecast, setAiForecast] = useState<AIForecastData | null>(null)
  const [forecastLoading, setForecastLoading] = useState(false)
  const [forecastError, setForecastError] = useState<string | null>(null)

  // ── Load everything once on mount ─────────────────────────────────────────
  // Read once instead of using live listeners. Analytics does not need
  // real-time updates, and four open listeners on large collections is slow.

  useEffect(() => {
    let cancelled = false
    async function loadData() {
      try {
        const [catSnap, salesSnap, invSnap, resSnap] = await Promise.all([
          getDocs(collection(db, 'categories')),
          getDocs(collection(db, 'sales')),
          getDocs(collection(db, 'inventory')),
          getDocs(collection(db, 'reservations')),
        ])
        if (cancelled) return

        const catRows = catSnap.docs
          .map((categoryDoc) => {
            const data = categoryDoc.data() as Record<string, unknown>
            return {
              id: categoryDoc.id,
              name: typeof data.name === 'string' && data.name.trim() ? data.name : categoryDoc.id,
            }
          })
          .sort((a, b) => a.name.localeCompare(b.name))
        setCategories(catRows)

        const salesRows: SaleRecord[] = salesSnap.docs.map((saleDoc) => {
          const data = saleDoc.data() as Record<string, unknown>
          return {
            id: saleDoc.id,
            items: Array.isArray(data.items)
              ? data.items
                  .map((item) => {
                    const saleItem = item as Record<string, unknown>
                    const name =
                      typeof saleItem.name === 'string' && saleItem.name.trim()
                        ? saleItem.name
                        : 'Unnamed Item'
                    return {
                      name,
                      quantity: Math.max(0, toNumber(saleItem.quantity, 0)),
                      price: Math.max(0, toNumber(saleItem.price, 0)),
                      categoryId:
                        typeof saleItem.categoryId === 'string' && saleItem.categoryId.trim()
                          ? saleItem.categoryId
                          : '',
                      condition: (saleItem.condition === 'Refurbished' ? 'Refurbished' : 'New') as SaleItemCondition,
                    }
                  })
                  .filter((item) => item.quantity > 0 || item.price > 0)
              : [],
            totalAmount: Math.max(0, toNumber(data.totalAmount, toNumber(data.total, toNumber(data.amount, 0)))),
            createdAt: toDate(data.createdAt),
          }
        })
        setSales(salesRows)

        const invRows: InventoryRecord[] = invSnap.docs
          .map((itemDoc) => {
            const data = itemDoc.data() as Record<string, unknown>
            const categoryId =
              typeof data.categoryId === 'string' && data.categoryId.trim() ? data.categoryId : ''
            const categoryName =
              typeof data.categoryName === 'string' && data.categoryName.trim() ? data.categoryName : ''
            return {
              id: itemDoc.id,
              categoryId,
              categoryName: categoryName || 'General',
              category: categoryName || 'General',
              quantity: Math.max(0, toNumber(data.stock ?? data.quantity, 0)),
              isDeleted: data.isDeleted === true,
            }
          })
          .filter((item) => item.isDeleted !== true)
        setInventory(invRows)

        const resRows: ReservationRecord[] = resSnap.docs.map((resDoc) => {
          const data = resDoc.data() as Record<string, unknown>
          const rawStatus = typeof data.status === 'string' ? data.status : ''
          const status = (['Active', 'Completed', 'Cancelled', 'Expired'] as const).includes(
            rawStatus as ReservationRecord['status']
          )
            ? (rawStatus as ReservationRecord['status'])
            : 'Active'
          return { id: resDoc.id, status, createdAt: toDate(data.createdAt) }
        })
        setReservations(resRows)
      } catch (_) {}
    }
    loadData()
    return () => { cancelled = true }
  }, [])

  // Resolve the selected category ID to its display name for the forecast API

  // ── AI forecast (the only server-side call on this page) ──────────────────
  const forecastCategoryName = useMemo(() => {
    if (selectedCategory === 'All Categories') return null
    const match = categories.find((c) => c.id === selectedCategory)
    return match?.name ?? null
  }, [selectedCategory, categories])

  // Auto-load AI forecast from cache on mount and when category changes
  useEffect(() => {
    let cancelled = false
    async function loadCachedForecast() {
      try {
        const params = new URLSearchParams()
        if (forecastCategoryName) params.set('category', forecastCategoryName)
        const qs = params.toString()
        const res = await fetch(`/api/forecast/ai-enhanced${qs ? `?${qs}` : ''}`)
        if (!res.ok) return
        const data: AIForecastData = await res.json()
        if (!cancelled) setAiForecast(data)
      } catch (_) {}
    }
    loadCachedForecast()
    return () => { cancelled = true }
  }, [forecastCategoryName])

  const handleGenerateForecast = async (force = false) => {
    setForecastLoading(true)
    setForecastError(null)
    try {
      const params = new URLSearchParams()
      if (force) params.set('force', 'true')
      if (forecastCategoryName) params.set('category', forecastCategoryName)
      const qs = params.toString()
      const url = `/api/forecast/ai-enhanced${qs ? `?${qs}` : ''}`
      const res = await fetch(url)
      const data: AIForecastData = await res.json()
      if (!res.ok) {
        setForecastError(data.reason ?? 'Forecast generation failed.')
      } else {
        setAiForecast(data)
      }
    } catch (_) {
      setForecastError('Network error — could not reach the forecast service.')
    } finally {
      setForecastLoading(false)
    }
  }

  const categoryNameMap = useMemo(
    () =>
      categories.reduce<Record<string, string>>((map, category) => {
        map[category.id] = category.name
        return map
      }, {}),
    [categories]
  )

  const availableCategoryIds = useMemo(() => {
    const ids = new Set<string>()
    sales.forEach((sale) => {
      sale.items.forEach((item) => {
        if (item.categoryId) ids.add(item.categoryId)
      })
    })
    return Array.from(ids).sort((a, b) => (categoryNameMap[a] ?? a).localeCompare(categoryNameMap[b] ?? b))
  }, [sales, categoryNameMap])


  // ── Date range: presets, custom range and validation ──────────────────────
  // activeRange is the single source of truth for every filtered number below.
  const activeRange = useMemo(() => {
    const now = new Date()

    if (timeRangePreset !== 'custom') {
      return getPresetRange(timeRangePreset, now)
    }

    const fallback = getPresetRange('this-month', now)
    const parsedStart = parseDateInput(customStartDate)
    const parsedEnd = parseDateInput(customEndDate)

    if (!parsedStart || !parsedEnd || parsedStart > parsedEnd) {
      return fallback
    }

    return {
      start: startOfDay(parsedStart),
      end: endOfDay(parsedEnd),
    }
  }, [customEndDate, customStartDate, timeRangePreset])

  useEffect(() => {
    if (timeRangePreset !== 'custom') return
    if (customStartDate && customEndDate) return

    const fallback = getPresetRange('this-month', new Date())
    setCustomStartDate((current) => current || formatDateInput(fallback.start))
    setCustomEndDate((current) => current || formatDateInput(fallback.end))
  }, [customEndDate, customStartDate, timeRangePreset])

  useEffect(() => {
    if (!customStartDate || !customEndDate) {
      setDateRangeError('')
      return
    }

    if (new Date(customEndDate) < new Date(customStartDate)) {
      setCustomEndDate(customStartDate)
      setDateRangeError('End date cannot be earlier than start date.')
      return
    }

    setDateRangeError('')
  }, [customEndDate, customStartDate])

  const handleCustomStartDateChange = (value: string) => {
    setTimeRangePreset('custom')
    setCustomStartDate(value)

    if (customEndDate && value && new Date(value) > new Date(customEndDate)) {
      setCustomEndDate(value)
      setDateRangeError('')
      return
    }

    if (value && customEndDate && new Date(customEndDate) < new Date(value)) {
      setDateRangeError('End date cannot be earlier than start date.')
      return
    }

    setDateRangeError('')
  }

  const handleCustomEndDateChange = (value: string) => {
    setTimeRangePreset('custom')

    if (customStartDate && value && new Date(value) < new Date(customStartDate)) {
      setCustomEndDate(customStartDate)
      setDateRangeError('End date cannot be earlier than start date.')
      return
    }

    setCustomEndDate(value)
    setDateRangeError('')
  }


  // ── Filtering and per-period summaries ────────────────────────────────────
  const filterSaleItems = (sale: SaleRecord) =>
    sale.items.filter((item) => {
      const categoryMatch = selectedCategory === 'All Categories' || item.categoryId === selectedCategory
      const conditionMatch = selectedCondition === 'All Conditions' || item.condition === selectedCondition
      return categoryMatch && conditionMatch
    })

  const mapFilteredSales = (rows: SaleRecord[], start: Date, end: Date) =>
    rows
      .filter((sale) => inRange(sale.createdAt, start, end))
      .map((sale) => {
        const items = filterSaleItems(sale)
        return {
          ...sale,
          items,
          totalAmount: items.reduce((sum, item) => sum + Number(item.quantity ?? 0) * Number(item.price ?? 0), 0),
        }
      })
      .filter((sale) => sale.items.length > 0 && sale.totalAmount > 0)

  const filteredSales = useMemo(
    () => mapFilteredSales(sales, activeRange.start, activeRange.end),
    [activeRange.end, activeRange.start, sales, selectedCategory, selectedCondition]
  )

  const previousPeriodRange = useMemo(
    () => getPreviousPeriodRange(activeRange.start, activeRange.end),
    [activeRange.end, activeRange.start]
  )

  const samePeriodLastYearRange = useMemo(
    () => getSamePeriodLastYearRange(activeRange.start, activeRange.end),
    [activeRange.end, activeRange.start]
  )

  const filteredPreviousPeriodSales = useMemo(
    () => mapFilteredSales(sales, previousPeriodRange.start, previousPeriodRange.end),
    [previousPeriodRange.end, previousPeriodRange.start, sales, selectedCategory, selectedCondition]
  )

  const filteredSamePeriodLastYearSales = useMemo(
    () => mapFilteredSales(sales, samePeriodLastYearRange.start, samePeriodLastYearRange.end),
    [samePeriodLastYearRange.end, samePeriodLastYearRange.start, sales, selectedCategory, selectedCondition]
  )

  const currentSummary = useMemo(
    () => summarizeSales(filteredSales, categoryNameMap),
    [categoryNameMap, filteredSales]
  )

  const previousSummary = useMemo(
    () => summarizeSales(filteredPreviousPeriodSales, categoryNameMap),
    [categoryNameMap, filteredPreviousPeriodSales]
  )

  const lastYearSummary = useMemo(
    () => summarizeSales(filteredSamePeriodLastYearSales, categoryNameMap),
    [categoryNameMap, filteredSamePeriodLastYearSales]
  )

  const trendSeries = useMemo(
    () => buildTrendSeries(filteredSales, activeRange.start, activeRange.end),
    [activeRange.end, activeRange.start, filteredSales]
  )

  const forecastSeries = useMemo(
    () => buildForecastSeries(trendSeries.rows, trendSeries.granularity),
    [trendSeries.granularity, trendSeries.rows]
  )

  const categoryForecast = useMemo(
    () => buildCategoryForecast(filteredSales, activeRange.start, activeRange.end, categoryNameMap, trendSeries.granularity),
    [activeRange.end, activeRange.start, categoryNameMap, filteredSales, trendSeries.granularity]
  )


  // ── Derived values for the KPI cards and panels ───────────────────────────
  const predictiveSummary = useMemo(() => {
    const topCategory = categoryForecast.topCategory
    const forecastWindow =
      trendSeries.granularity === 'day'
        ? `next ${forecastSeries.steps} days`
        : `next ${forecastSeries.steps} period`

    return {
      forecastWindow,
      projectedSales: forecastSeries.projectedTotal,
      projectedFastMovingCategory: topCategory?.categoryName ?? 'Insufficient data',
      projectedCategoryRevenue: topCategory?.projectedRevenue ?? 0,
      projectedCategoryItems: topCategory?.projectedItemsSold ?? 0,
    }
  }, [categoryForecast.topCategory, forecastSeries.projectedTotal, forecastSeries.steps, trendSeries.granularity])

  const comparisonMetrics = useMemo(() => {
    const topCategoryRevenue = currentSummary.topCategory?.revenue ?? 0
    const previousTopCategoryRevenue = previousSummary.topCategory?.revenue ?? 0
    const lastYearTopCategoryRevenue = lastYearSummary.topCategory?.revenue ?? 0

    return {
      totalSales: [
        {
          label: 'Vs last period',
          value: previousSummary.totalSales,
          change: calculatePercentChange(currentSummary.totalSales, previousSummary.totalSales),
        },
        {
          label: 'Vs same period last year',
          value: lastYearSummary.totalSales,
          change: calculatePercentChange(currentSummary.totalSales, lastYearSummary.totalSales),
        },
      ] satisfies ComparisonMetric[],
      itemsSold: [
        {
          label: 'Vs last period',
          value: previousSummary.itemsSold,
          change: calculatePercentChange(currentSummary.itemsSold, previousSummary.itemsSold),
        },
        {
          label: 'Vs same period last year',
          value: lastYearSummary.itemsSold,
          change: calculatePercentChange(currentSummary.itemsSold, lastYearSummary.itemsSold),
        },
      ] satisfies ComparisonMetric[],
      topCategory: [
        {
          label: 'Vs last period',
          value: previousTopCategoryRevenue,
          change: calculatePercentChange(topCategoryRevenue, previousTopCategoryRevenue),
        },
        {
          label: 'Vs same period last year',
          value: lastYearTopCategoryRevenue,
          change: calculatePercentChange(topCategoryRevenue, lastYearTopCategoryRevenue),
        },
      ] satisfies ComparisonMetric[],
    }
  }, [currentSummary, lastYearSummary, previousSummary])

  const analyticsSummary = useMemo(
    () =>
      generateSummary({
        timeRangeLabel: getRangeLabel(timeRangePreset),
        totalSales: currentSummary.totalSales,
        itemsSold: currentSummary.itemsSold,
        topCategory: currentSummary.topCategory?.categoryName ?? null,
        salesChangePercent: comparisonMetrics.totalSales[0]?.change ?? null,
        topCategoryRevenue: currentSummary.topCategory?.revenue ?? 0,
      }),
    [comparisonMetrics.totalSales, currentSummary, timeRangePreset]
  )

  const inventorySummary = useMemo(() => {
    const stockByCategory = new Map<string, number>()

    inventory.forEach((item) => {
      const categoryName = item.categoryName ?? item.category ?? 'General'
      stockByCategory.set(categoryName, Number(stockByCategory.get(categoryName) ?? 0) + Number(item.quantity ?? 0))
    })

    return Array.from(stockByCategory.entries())
      .map(([categoryName, stock]) => ({ categoryName, stock }))
      .sort((a, b) => a.categoryName.localeCompare(b.categoryName))
  }, [inventory])

  // Counts reservations by status for the selected date range
  const reservationActivity = useMemo(() => {
    const filtered = reservations.filter((r) => inRange(r.createdAt, activeRange.start, activeRange.end))
    const counts: Record<ReservationRecord['status'], number> = {
      Active: 0,
      Completed: 0,
      Cancelled: 0,
      Expired: 0,
    }
    filtered.forEach((r) => {
      counts[r.status]++
    })
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0)
    return { counts, total }
  }, [reservations, activeRange.start, activeRange.end])

  // ── CSV export of everything currently on screen ──────────────────────────
  const handleExportCsv = () => {
    const esc = (v: unknown) => {
      const str = String(v ?? '')
      return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str
    }
    const money = (n: number) => (Math.round(n * 100) / 100).toFixed(2)
    const rows: string[] = []
    const section = (title: string) => { rows.push(''); rows.push(esc(title)) }

    const rangeLabel = `${formatDateInput(activeRange.start)} to ${formatDateInput(activeRange.end)}`
    const categoryLabel =
      selectedCategory === 'All Categories' ? 'All Categories' : (categoryNameMap[selectedCategory] ?? selectedCategory)

    // Header block
    rows.push(esc('SUSTAIN — Analytics Export'))
    rows.push(['Generated', esc(new Date().toLocaleString('en-PH'))].join(','))
    rows.push(['Date Range', esc(rangeLabel)].join(','))
    rows.push(['Period', esc(getRangeLabel(timeRangePreset))].join(','))
    rows.push(['Category Filter', esc(categoryLabel)].join(','))
    rows.push(['Condition Filter', esc(selectedCondition)].join(','))

    // Summary
    section('SUMMARY')
    rows.push('Metric,Value')
    rows.push(['Total Sales', money(currentSummary.totalSales)].join(','))
    rows.push(['Items Sold', currentSummary.itemsSold].join(','))
    rows.push(['Transactions', filteredSales.length].join(','))
    rows.push(['Average Order Value',
      money(filteredSales.length ? currentSummary.totalSales / filteredSales.length : 0)].join(','))
    rows.push(['Previous Period Sales', money(previousSummary.totalSales)].join(','))
    rows.push(['Change vs Previous Period (%)',
      previousSummary.totalSales > 0
        ? (((currentSummary.totalSales - previousSummary.totalSales) / previousSummary.totalSales) * 100).toFixed(1)
        : 'n/a'].join(','))

    // Sales over time
    section('SALES OVER TIME')
    rows.push('Period,Revenue')
    trendSeries.rows.forEach(r => rows.push([esc(r.label), money(r.total)].join(',')))

    // Category performance
    section('CATEGORY PERFORMANCE')
    rows.push('Rank,Category,Items Sold,Revenue,Share of Sales (%)')
    currentSummary.categories.forEach((c, i) => {
      const share = currentSummary.totalSales > 0 ? (c.revenue / currentSummary.totalSales) * 100 : 0
      rows.push([i + 1, esc(c.categoryName), c.itemsSold, money(c.revenue), share.toFixed(1)].join(','))
    })

    // Forecast
    section('FORECAST')
    rows.push(['Method', esc(forecastSeries.note)].join(','))
    rows.push(['Projected Total', money(forecastSeries.projectedTotal)].join(','))
    rows.push('')
    rows.push('Period,Projected Revenue')
    const actualCount = trendSeries.rows.length
    forecastSeries.labels.slice(actualCount).forEach((label, i) => {
      const val = forecastSeries.forecastValues[actualCount + i]
      rows.push([esc(label), money(typeof val === 'number' ? val : 0)].join(','))
    })

    // AI insight, when one has been generated
    if (aiForecast?.aiForecast?.insight) {
      section('AI INSIGHT')
      rows.push(['Confidence', esc(aiForecast.aiForecast.confidence ?? '')].join(','))
      rows.push(['Insight', esc(aiForecast.aiForecast.insight)].join(','))
      rows.push(['Note', esc('Forecast computed by EWMA statistical model; AI adjustment bounded to +/-15%.')].join(','))
    }

    // Trigger the download
    const blob = new Blob(['\uFEFF' + rows.join('\n')], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `SUSTAIN-Analytics-${formatDateInput(activeRange.start)}-to-${formatDateInput(activeRange.end)}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }


  // ── Table rows and modal contents ─────────────────────────────────────────
  const topCategoryRows = useMemo(
    () =>
      currentSummary.categories.slice(0, 6).map((row, index) => ({
        key: row.categoryId,
        cells: [
          <span key={`${row.categoryId}-rank`} className="font-medium text-slate-900">{index + 1}</span>,
          <span key={`${row.categoryId}-name`} className="font-medium text-slate-900">{row.categoryName}</span>,
          <span key={`${row.categoryId}-items`} className="block text-right">{compactNumber.format(row.itemsSold)}</span>,
          <span key={`${row.categoryId}-revenue`} className="block text-right">{currency(row.revenue)}</span>,
        ],
      })),
    [currentSummary.categories]
  )

  const allTopCategoryRows = useMemo(
    () =>
      currentSummary.categories.map((row, index) => ({
        key: row.categoryId,
        cells: [
          <span key={`${row.categoryId}-rank`} className="font-medium text-slate-900">{index + 1}</span>,
          <span key={`${row.categoryId}-name`} className="font-medium text-slate-900">{row.categoryName}</span>,
          <span key={`${row.categoryId}-items`} className="block text-right">{compactNumber.format(row.itemsSold)}</span>,
          <span key={`${row.categoryId}-revenue`} className="block text-right">{currency(row.revenue)}</span>,
        ],
      })),
    [currentSummary.categories]
  )

  const stockRows = useMemo(
    () =>
      inventorySummary.slice(0, 6).map((row) => ({
        key: row.categoryName,
        cells: [
          <span key={`${row.categoryName}-name`} className="font-medium text-slate-900">{row.categoryName}</span>,
          <span key={`${row.categoryName}-stock`} className="block text-right">{compactNumber.format(row.stock)}</span>,
        ],
      })),
    [inventorySummary]
  )

  const modalConfig = useMemo(() => {
    if (openModal !== 'top') return null

    return {
      title: `Top Categories - ${getRangeLabel(timeRangePreset)}`,
      columns: [
        { header: '#' },
        { header: 'Category' },
        { header: 'Items Sold', className: 'text-right' },
        { header: 'Sales', className: 'text-right' },
      ],
      rows: allTopCategoryRows,
    }
  }, [allTopCategoryRows, openModal, timeRangePreset])

  // ── Extra computed values for the redesigned UI ──────────────────────────
  const salesByCondition = useMemo(() => {
    let newTotal = 0
    let refurbishedTotal = 0
    filteredSales.forEach((sale) => {
      sale.items.forEach((item) => {
        const amt = item.quantity * item.price
        if (item.condition === 'Refurbished') refurbishedTotal += amt
        else newTotal += amt
      })
    })
    return { new: newTotal, refurbished: refurbishedTotal, total: newTotal + refurbishedTotal }
  }, [filteredSales])

  const topProducts = useMemo(() => {
    const map = new Map<string, { name: string; qty: number; revenue: number }>()
    filteredSales.forEach((sale) => {
      sale.items.forEach((item) => {
        const cur = map.get(item.name) ?? { name: item.name, qty: 0, revenue: 0 }
        cur.qty += item.quantity
        cur.revenue += item.quantity * item.price
        map.set(item.name, cur)
      })
    })
    return Array.from(map.values())
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 6)
  }, [filteredSales])

  const aiConfidenceNum = useMemo(() => {
    const c = aiForecast?.aiForecast?.confidence?.toLowerCase() ?? ''
    if (c === 'high') return 92
    if (c === 'medium') return 68
    if (c === 'low') return 41
    return null
  }, [aiForecast])

  const mergedChartData = useMemo(() => {
    const actualLen = trendSeries.rows.length
    const forecastLen = forecastSeries.steps
    const hasAI = !!(
      aiForecast?.canForecast &&
      aiForecast.aiForecast?.forecast &&
      aiForecast.aiForecast.forecast.length >= forecastLen
    )
    if (!hasAI || actualLen === 0) {
      return {
        hasAI: false as const,
        aiValues: null,
        baseValues: null,
        confUpper: null,
        confLower: null,
      }
    }
    const bridge = trendSeries.rows[actualLen - 1]?.total ?? 0
    const forecast = aiForecast!.aiForecast!.forecast.slice(0, forecastLen)
    const leadNulls = Math.max(0, actualLen - 1)

    // The statistical baseline the AI was actually bounded against.
    //
    // Taken from the same API response rather than recomputed in the browser.
    // A browser-side recalculation would use the selected date range, while the
    // server uses a 28-day window - so the two lines would be drawn from
    // different data and the ±15% relationship between them would not hold.
    const base = aiForecast!.baseForecast?.forecast?.slice(0, forecastLen) ?? []
    const baseValues =
      base.length === forecastLen
        ? [...Array<null>(leadNulls).fill(null), bridge, ...base.map((d) => d.weighted)]
        : null

    return {
      hasAI: true as const,
      aiValues: [...Array<null>(leadNulls).fill(null), bridge, ...forecast.map((d) => d.ai)],
      baseValues,
      confUpper: [...Array<null>(actualLen).fill(null), ...forecast.map((d) => d.ai * 1.12)],
      confLower: [...Array<null>(actualLen).fill(null), ...forecast.map((d) => d.ai * 0.88)],
    }
  }, [trendSeries.rows, forecastSeries.steps, aiForecast])

  // Compute y-axis minimum: start at 70% of lowest non-zero value so the chart
  // doesn't waste half its height on blank space below the actual data range.
  // Y-axis minimum: only raise above 0 when every data point is non-zero.
  // If any actual sale day is ₱0 we must start at 0 so those points remain visible.
  const chartYMin = useMemo(() => {
    const actualVals = trendSeries.rows.map((r) => r.total)
    if (actualVals.some((v) => v <= 0)) return 0          // keep ₱0 days on-screen
    const aiVals = mergedChartData.aiValues?.filter((v): v is number => v !== null) ?? []
    const allVals = [...actualVals, ...aiVals]
    if (allVals.length === 0) return 0
    return Math.max(0, Math.min(...allVals) * 0.75)         // 25% breathing room below min
  }, [trendSeries.rows, mergedChartData])


  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <main className="min-h-screen bg-[#F8FAFC] px-4 py-3">
      <div className="mx-auto max-w-[1440px] space-y-3">

        {/* ── PAGE HEADER ──────────────────────────────────────────────────── */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-blue-600 shadow-sm">
              <svg className="h-4 w-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/>
              </svg>
            </div>
            <div>
              <h1 className="text-lg font-bold text-slate-900">Analytics</h1>
              <p className="text-xs text-slate-400">Sales performance, demand &amp; AI forecasting</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600 shadow-sm">
              <svg className="h-3.5 w-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/>
              </svg>
              <span className="font-medium">{activeRange.start.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
              <span className="text-slate-300">–</span>
              <span className="font-medium">{activeRange.end.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
            </div>
            <button
              type="button"
              onClick={handleExportCsv}
              title="Download the current view as a CSV file"
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-blue-700 transition"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
              </svg>
              Export
            </button>
          </div>
        </div>

        {/* ── FILTERS ──────────────────────────────────────────────────────── */}
        <div className="rounded-xl border border-slate-100 bg-white px-4 py-3 shadow-sm">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold uppercase tracking-wide text-slate-400">Time Range</label>
                <select
                  value={timeRangePreset}
                  onChange={(e) => setTimeRangePreset(e.target.value as TimeRangePreset)}
                  className="h-9 rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm font-medium text-slate-700 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100 transition"
                >
                  <option value="this-week">This Week</option>
                  <option value="this-month">This Month</option>
                  <option value="last-month">Last Month</option>
                  <option value="last-6-months">Last 6 Months</option>
                  <option value="this-year">This Year</option>
                  <option value="custom">Custom Range</option>
                </select>
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold uppercase tracking-wide text-slate-400">Start Date</label>
                <input
                  type="date"
                  value={timeRangePreset === 'custom' ? customStartDate : formatDateInput(activeRange.start)}
                  max={timeRangePreset === 'custom' && customEndDate ? customEndDate : undefined}
                  onChange={(e) => handleCustomStartDateChange(e.target.value)}
                  className="h-9 rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm text-slate-700 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100 transition"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold uppercase tracking-wide text-slate-400">End Date</label>
                <input
                  type="date"
                  value={timeRangePreset === 'custom' ? customEndDate : formatDateInput(activeRange.end)}
                  min={timeRangePreset === 'custom' && customStartDate ? customStartDate : undefined}
                  onChange={(e) => handleCustomEndDateChange(e.target.value)}
                  className="h-9 rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm text-slate-700 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100 transition"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold uppercase tracking-wide text-slate-400">Category</label>
                <select
                  value={selectedCategory}
                  onChange={(e) => setSelectedCategory(e.target.value)}
                  className="h-9 rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm font-medium text-slate-700 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100 transition"
                >
                  <option value="All Categories">All Categories</option>
                  {availableCategoryIds.map((id) => (
                    <option key={id} value={id}>{categoryNameMap[id] ?? id}</option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold uppercase tracking-wide text-slate-400">Condition</label>
                <select
                  value={selectedCondition}
                  onChange={(e) => setSelectedCondition(e.target.value === 'Refurbished' ? 'Refurbished' : e.target.value === 'New' ? 'New' : 'All Conditions')}
                  className="h-9 rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm font-medium text-slate-700 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100 transition"
                >
                  <option value="All Conditions">All Conditions</option>
                  <option value="New">New</option>
                  <option value="Refurbished">Refurbished</option>
                </select>
              </div>
            </div>
            <div className="flex items-end gap-2">
              {timeRangePreset === 'custom' && dateRangeError && (
                <p className="text-xs text-red-500">{dateRangeError}</p>
              )}
              <button
                type="button"
                onClick={() => { setTimeRangePreset('this-month'); setCustomStartDate(''); setCustomEndDate(''); setSelectedCategory('All Categories'); setSelectedCondition('All Conditions') }}
                className="h-9 rounded-lg border border-slate-200 bg-white px-4 text-sm font-medium text-slate-600 hover:bg-slate-50 transition"
              >
                Reset Filters
              </button>
            </div>
          </div>
        </div>

        {/* ── KPI CARDS ────────────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">

          {/* Total Sales */}
          <div className="rounded-xl border border-slate-100 bg-white p-3 shadow-sm">
            <div className="flex items-start justify-between">
              <div className="min-w-0">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Total Sales</p>
                <p className="mt-1 text-base font-bold text-slate-900">{currency(currentSummary.totalSales)}</p>
              </div>
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-blue-50">
                <svg className="h-4 w-4 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
                </svg>
              </div>
            </div>
            {comparisonMetrics.totalSales[0] && (
              <div className="mt-1.5 flex items-center gap-1">
                <span className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${(comparisonMetrics.totalSales[0].change ?? 0) >= 0 ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-600'}`}>
                  {(comparisonMetrics.totalSales[0].change ?? 0) >= 0 ? '↑' : '↓'} {percentFormatter.format(Math.abs(comparisonMetrics.totalSales[0].change ?? 0))}%
                </span>
                <span className="text-[10px] text-slate-400">vs last period</span>
              </div>
            )}
          </div>

          {/* Items Sold */}
          <div className="rounded-xl border border-slate-100 bg-white p-3 shadow-sm">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Items Sold</p>
                <p className="mt-1 text-base font-bold text-slate-900">{compactNumber.format(currentSummary.itemsSold)}</p>
              </div>
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-green-50">
                <svg className="h-4 w-4 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/>
                </svg>
              </div>
            </div>
            {comparisonMetrics.itemsSold[0] && (
              <div className="mt-1.5 flex items-center gap-1">
                <span className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${(comparisonMetrics.itemsSold[0].change ?? 0) >= 0 ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-600'}`}>
                  {(comparisonMetrics.itemsSold[0].change ?? 0) >= 0 ? '↑' : '↓'} {percentFormatter.format(Math.abs(comparisonMetrics.itemsSold[0].change ?? 0))}%
                </span>
                <span className="text-[10px] text-slate-400">vs last period</span>
              </div>
            )}
          </div>

          {/* Average Order Value */}
          <div className="rounded-xl border border-slate-100 bg-white p-3 shadow-sm">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Avg Order</p>
                <p className="mt-1 text-base font-bold text-slate-900">
                  {currentSummary.itemsSold > 0 ? currency(currentSummary.totalSales / currentSummary.itemsSold) : '₱0.00'}
                </p>
              </div>
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-violet-50">
                <svg className="h-4 w-4 text-violet-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z"/>
                </svg>
              </div>
            </div>
            <p className="mt-2 text-[10px] text-slate-400">per item sold</p>
          </div>

          {/* Transactions */}
          <div className="rounded-xl border border-slate-100 bg-white p-3 shadow-sm">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Transactions</p>
                <p className="mt-1 text-base font-bold text-slate-900">{filteredSales.length}</p>
              </div>
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-orange-50">
                <svg className="h-4 w-4 text-orange-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/>
                </svg>
              </div>
            </div>
            <p className="mt-2 text-[10px] text-slate-400">completed sales</p>
          </div>

          {/* Projected Demand */}
          <div className="rounded-xl border border-slate-100 bg-white p-3 shadow-sm">
            <div className="flex items-start justify-between">
              <div className="min-w-0 flex-1">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Proj. Demand</p>
                <p className="mt-1.5 truncate text-sm font-bold text-indigo-700">{predictiveSummary.projectedFastMovingCategory}</p>
              </div>
              <div className="ml-2 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-indigo-50">
                <svg className="h-4 w-4 text-indigo-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"/>
                </svg>
              </div>
            </div>
            <div className="mt-2">
              <span className="inline-flex items-center rounded-full bg-indigo-50 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-700">High</span>
              <span className="ml-1.5 text-[10px] text-slate-400">demand</span>
            </div>
          </div>

          {/* AI Confidence Score */}
          <div className="rounded-xl border border-slate-100 bg-white p-3 shadow-sm">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">AI Confidence</p>
                <p className="mt-1 text-base font-bold text-violet-700">
                  {aiConfidenceNum !== null ? `${aiConfidenceNum}%` : '—'}
                </p>
              </div>
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-violet-50">
                <svg className="h-4 w-4 text-violet-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17H3a2 2 0 01-2-2V5a2 2 0 012-2h14a2 2 0 012 2v10a2 2 0 01-2 2h-2"/>
                </svg>
              </div>
            </div>
            <div className="mt-2">
              <span className="inline-flex items-center rounded-full bg-violet-50 px-1.5 py-0.5 text-[10px] font-semibold text-violet-700">
                {aiForecast?.aiForecast?.confidence ?? 'No forecast'}
              </span>
            </div>
          </div>
        </div>

        {/* ── MAIN: Chart (75%) + AI Insights Panel (25%) ─────────────────── */}
        <div className="grid grid-cols-1 gap-2 xl:grid-cols-[3fr_1fr]" style={{ alignItems: 'stretch' }}>

          {/* ── Sales Trend + AI Forecast chart card ────────────────────────── */}
          <div className="flex flex-col overflow-hidden rounded-xl border border-slate-100 bg-white shadow-sm">

            {/* Card header */}
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-2.5">
              <div className="flex items-center gap-2">
                <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-blue-600">
                  <svg className="h-3.5 w-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"/>
                  </svg>
                </div>
                <div>
                  <h2 className="text-sm font-bold text-slate-900">Sales Trend &amp; AI Forecast</h2>
                  <p className="text-[10px] text-slate-400">
                    {trendSeries.granularity === 'day' ? 'Daily' : 'Monthly'} ·{' '}
                    {activeRange.start.toLocaleDateString('en-PH', { month: 'short', day: 'numeric' })} –{' '}
                    {activeRange.end.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })}
                  </p>
                </div>
              </div>

              <div className="flex shrink-0 flex-wrap items-center gap-2">
                {/* Metadata chips */}
                <span className="inline-flex items-center gap-1 rounded-full border border-violet-100 bg-violet-50 px-2 py-0.5 text-[10px] font-semibold text-violet-700">
                  <span className="h-1.5 w-1.5 rounded-full bg-violet-400"/>
                  {aiConfidenceNum !== null ? `${aiConfidenceNum}% Confidence` : 'No AI'}
                </span>
                <span className="inline-flex items-center gap-1 rounded-full border border-blue-100 bg-blue-50 px-2 py-0.5 text-[10px] font-semibold text-blue-700">
                  <span className="h-1.5 w-1.5 rounded-full bg-blue-400"/>
                  {trendSeries.granularity === 'day' ? '7-day' : '1-period'} Forecast
                </span>
                {/* Legend */}
                <span className="flex items-center gap-1 text-[10px] text-slate-500">
                  <span className="inline-block h-0.5 w-4 rounded-full bg-blue-600"/>Actual
                </span>
                {/* Statistical baseline is always drawn. When AI refinement is
                    active it sits beside the AI line, so the ±15% bound between
                    them is visible rather than merely claimed. */}
                <span className="flex items-center gap-1 text-[10px] text-slate-500">
                  <svg width="16" height="4" viewBox="0 0 16 4"><line x1="0" y1="2" x2="16" y2="2" stroke={mergedChartData.hasAI ? '#cbd5e1' : '#94a3b8'} strokeWidth="2" strokeDasharray="4 3"/></svg>
                  {mergedChartData.hasAI ? 'EWMA baseline' : 'Forecast'}
                </span>
                {mergedChartData.hasAI && (
                  <span className="flex items-center gap-1 text-[10px] text-slate-500">
                    <svg width="16" height="4" viewBox="0 0 16 4"><line x1="0" y1="2" x2="16" y2="2" stroke="#7c3aed" strokeWidth="2" strokeDasharray="4 3"/></svg>AI refined
                  </span>
                )}
              </div>
            </div>

            {/* Chart area — fixed compact height */}
            <div className="relative h-[355px] px-3 pb-2 pt-2">
              <Line
                // The forecast region used to be marked with a shaded band, a
                // vertical divider and a "Forecast Starts" label. It was drawn at
                // the wrong index and sat several days left of where the forecast
                // actually begins, so it has been removed rather than left wrong.
                //
                // Nothing is lost by dropping it: the solid blue line is recorded
                // sales and the dashed purple line is the projection, which the
                // legend above the chart already states.
                plugins={[]}
                data={{
                  labels: forecastSeries.labels,
                  datasets: [
                    // Confidence band upper → fills to next dataset (lower)
                    ...(mergedChartData.hasAI ? [{
                      label: '_confUpper',
                      data: mergedChartData.confUpper,
                      fill: '+1' as unknown as boolean,
                      backgroundColor: 'rgba(139,92,246,0.13)',
                      borderWidth: 0,
                      pointRadius: 0,
                      tension: 0.35,
                      spanGaps: true,
                    }] : []),
                    // Confidence band lower
                    ...(mergedChartData.hasAI ? [{
                      label: '_confLower',
                      data: mergedChartData.confLower,
                      fill: false as unknown as boolean,
                      backgroundColor: 'transparent',
                      borderWidth: 0,
                      pointRadius: 0,
                      tension: 0.35,
                      spanGaps: true,
                    }] : []),
                    // Actual Sales
                    {
                      label: 'Actual Sales',
                      data: forecastSeries.actualValues,
                      fill: true,
                      borderColor: '#2563eb',
                      backgroundColor: 'rgba(37,99,235,0.06)',
                      borderWidth: 2.5,
                      pointRadius: trendSeries.hasSinglePoint ? 6 : 3,
                      pointHoverRadius: 5,
                      tension: 0.3,
                    },
                    // Statistical baseline (EWMA) - always drawn.
                    //
                    // This is the forecast before any AI involvement. It is shown
                    // alongside the AI line so the bounded refinement is visible:
                    // the two can never diverge by more than 15%, which is the
                    // whole basis of the hybrid model. Drawn thin and grey so it
                    // reads as a reference line rather than a competing forecast.
                    {
                      label: mergedChartData.hasAI ? 'Statistical baseline' : 'Forecast',
                      // Prefer the server's own baseline when the AI layer ran, so
                      // both lines come from one computation. Falls back to the
                      // browser-side forecast when the API is unavailable.
                      data: mergedChartData.baseValues ?? forecastSeries.forecastValues,
                      borderColor: mergedChartData.hasAI ? '#cbd5e1' : '#94a3b8',
                      backgroundColor: 'transparent',
                      borderWidth: mergedChartData.hasAI ? 1.5 : 2,
                      borderDash: [6, 4],
                      pointRadius: mergedChartData.hasAI ? 0 : 0,
                      pointHoverRadius: 4,
                      tension: 0.3,
                      spanGaps: true,
                    },
                    // AI Forecast line
                    ...(mergedChartData.hasAI ? [{
                      label: 'AI Forecast',
                      data: mergedChartData.aiValues,
                      borderColor: '#7c3aed',
                      backgroundColor: 'transparent',
                      borderWidth: 2.5,
                      borderDash: [7, 4],
                      pointRadius: 3,
                      pointHoverRadius: 5,
                      tension: 0.35,
                      spanGaps: true,
                    }] : []),
                  ],
                }}
                options={{
                  responsive: true,
                  maintainAspectRatio: false,
                  interaction: { mode: 'index', intersect: false },
                  plugins: {
                    legend: { display: false },
                    tooltip: {
                      backgroundColor: 'rgba(15,23,42,0.85)',
                      titleColor: '#e2e8f0',
                      bodyColor: '#cbd5e1',
                      padding: 12,
                      cornerRadius: 10,
                      filter: (item) => !(item.dataset.label ?? '').startsWith('_'),
                      callbacks: {
                        label: (ctx) => ` ${ctx.dataset.label}: ${currency(Number(ctx.parsed.y ?? 0))}`,
                      },
                    },
                  },
                  scales: {
                    x: {
                      grid: { display: false },
                      border: { display: false },
                      ticks: { font: { size: 11 }, color: '#94a3b8', maxRotation: 0, autoSkipPadding: 12 },
                    },
                    y: {
                      beginAtZero: false,
                      min: chartYMin,
                      grid: { color: '#f1f5f9' },
                      border: { display: false, dash: [4, 4] },
                      ticks: {
                        font: { size: 11 },
                        color: '#94a3b8',
                        padding: 8,
                        maxTicksLimit: 5,
                        callback: (v) => `₱${Number(v).toLocaleString('en-PH')}`,
                      },
                    },
                  },
                }}
              />
            </div>

            {/* Footer note */}
            <div className="flex items-center gap-1 px-4 pt-1 pb-2">
              <svg className="h-3 w-3 shrink-0 text-violet-400" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd"/>
              </svg>
              <p className="text-[10px] text-slate-400">
                AI forecast based on historical sales trends.
                {mergedChartData.hasAI && aiForecast?.fromCache && (
                  <span className="ml-1 text-violet-400">· Cached</span>
                )}
              </p>
            </div>
          </div>

          {/* ── AI Forecast Insights Panel ───────────────────────────────────── */}
          <div className="flex flex-col overflow-hidden rounded-xl border border-slate-100 bg-white shadow-sm">

            {/* Panel header */}
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
              <div className="flex items-center gap-2">
                <div className="flex h-6 w-6 items-center justify-center rounded-md bg-violet-100">
                  <span className="text-xs leading-none">✨</span>
                </div>
                <h2 className="text-sm font-bold text-slate-900">AI Insights</h2>
              </div>
              {aiForecast?.fromCache && (
                <span className="rounded-full bg-violet-50 px-1.5 py-0.5 text-[10px] font-semibold text-violet-500">CACHED</span>
              )}
            </div>

            {/* Scrollable content */}
            <div className="flex flex-1 flex-col gap-1.5 overflow-y-auto px-3 py-2">

              {/* Generate button */}
              <button
                type="button"
                onClick={() => handleGenerateForecast(true)}
                disabled={forecastLoading}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-violet-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-60 transition"
              >
                {forecastLoading ? (
                  <>
                    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z"/>
                    </svg>
                    Generating…
                  </>
                ) : (
                  <>
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
                    </svg>
                    {aiForecast ? 'Regenerate' : 'Generate Forecast'}
                  </>
                )}
              </button>

              {forecastError && (
                <div className="rounded-xl border border-red-100 bg-red-50 px-3 py-2.5 text-xs text-red-600">
                  {forecastError}
                </div>
              )}

              {forecastLoading && (
                <div className="flex flex-1 flex-col items-center justify-center gap-2 py-10">
                  <svg className="h-7 w-7 animate-spin text-violet-400" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z"/>
                  </svg>
                  <p className="text-xs text-slate-400">Running AI analysis…</p>
                </div>
              )}

              {!forecastLoading && !aiForecast && (
                <div className="flex flex-1 flex-col items-center justify-center gap-3 py-10 text-center">
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-violet-50">
                    <span className="text-2xl">🧠</span>
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-slate-700">No forecast yet</p>
                    <p className="mt-1 text-xs leading-relaxed text-slate-400">Click Generate to get an AI-powered 7-day demand prediction.</p>
                  </div>
                </div>
              )}

              {!forecastLoading && aiForecast && !aiForecast.canForecast && (
                <div className="rounded-xl border border-amber-100 bg-amber-50 px-3 py-3 text-xs text-amber-700">
                  {aiForecast.reason ?? 'Insufficient sales history for a reliable forecast.'}
                </div>
              )}

              {!forecastLoading && aiForecast?.canForecast && aiForecast.aiForecast && (
                <>
                  {/* AI Insight */}
                  <div className="rounded-xl bg-violet-50 p-2.5">
                    <p className="mb-1 text-[10px] font-bold uppercase tracking-widest text-violet-400">📈 AI Insight</p>
                    <p className="text-xs leading-relaxed text-slate-600">{aiForecast.aiForecast.insight}</p>
                  </div>

                  {/* Confidence Score bar */}
                  <div className="rounded-xl border border-slate-100 bg-slate-50 p-2.5">
                    <div className="mb-2 flex items-center justify-between">
                      <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">🧠 Confidence</p>
                      <span className="text-sm font-bold text-slate-900">{aiConfidenceNum !== null ? `${aiConfidenceNum}%` : '—'}</span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200">
                      <div
                        className={`h-full rounded-full transition-all duration-500 ${(aiConfidenceNum ?? 0) >= 80 ? 'bg-green-500' : (aiConfidenceNum ?? 0) >= 60 ? 'bg-yellow-500' : 'bg-orange-500'}`}
                        style={{ width: `${aiConfidenceNum ?? 0}%` }}
                      />
                    </div>
                    <p className="mt-1.5 text-[10px] font-semibold text-slate-400">{aiForecast.aiForecast.confidence} Confidence · AI Predictive Engine</p>
                  </div>

                  {/* Fast-moving category */}
                  {aiForecast.summary && (
                    <div className="rounded-xl border border-slate-100 bg-slate-50 p-2.5">
                      <p className="mb-1.5 text-[10px] font-bold uppercase tracking-widest text-slate-400">🔥 Fast-Moving</p>
                      <p className="text-sm font-bold text-slate-900">{aiForecast.summary.topCategories[0]?.name ?? '—'}</p>
                      <p className="mt-0.5 text-xs text-slate-400">{currency(aiForecast.summary.topCategories[0]?.revenue ?? 0)} revenue</p>
                    </div>
                  )}

                  {/* Last 7d + WoW */}
                  {aiForecast.summary && (
                    <div className="grid grid-cols-2 gap-2">
                      <div className="rounded-xl border border-slate-100 bg-slate-50 p-3">
                        <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Last 7d</p>
                        <p className="mt-1 text-xs font-bold tabular-nums text-slate-900">{currency(aiForecast.summary.last7Revenue)}</p>
                      </div>
                      <div className="rounded-xl border border-slate-100 bg-slate-50 p-3">
                        <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">WoW</p>
                        <p className={`mt-1 text-sm font-bold tabular-nums ${aiForecast.summary.wowChange >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                          {aiForecast.summary.wowChange >= 0 ? '+' : ''}{aiForecast.summary.wowChange.toFixed(1)}%
                        </p>
                      </div>
                    </div>
                  )}

                  {/* Recommended restock from top categories */}
                  {aiForecast.summary && aiForecast.summary.topCategories.length > 1 && (
                    <div className="rounded-xl border border-slate-100 bg-slate-50 p-2.5">
                      <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-slate-400">📦 Top Categories</p>
                      <div className="space-y-1.5">
                        {aiForecast.summary.topCategories.slice(0, 3).map((cat, i) => (
                          <div key={cat.name} className="flex items-center justify-between gap-2">
                            <span className="flex items-center gap-1.5 min-w-0">
                              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${i === 0 ? 'bg-violet-500' : i === 1 ? 'bg-blue-400' : 'bg-slate-400'}`}/>
                              <span className="truncate text-xs text-slate-600">{cat.name}</span>
                            </span>
                            <span className="shrink-0 text-xs font-semibold text-slate-900">{cat.units}u</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {aiForecast.aiForecast.warning && (
                    <div className="rounded-xl border border-amber-100 bg-amber-50 px-3 py-2.5">
                      <p className="text-xs text-amber-700">⚠ {aiForecast.aiForecast.warning}</p>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Panel footer */}
            <div className="border-t border-slate-50 px-3 py-1">
              <p className="text-[10px] text-slate-400">Predictive AI Engine · {trendSeries.granularity === 'day' ? '7-day' : '1-period'} window</p>
            </div>
          </div>
        </div>

        {/* ── LOWER CHARTS ROW ─────────────────────────────────────────────── */}
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">

          {/* Category Distribution */}
          <div className="rounded-xl border border-slate-100 bg-white p-3 shadow-sm">
            <h3 className="text-sm font-bold text-slate-900">Category Distribution</h3>
            <p className="mt-0.5 mb-3 text-xs text-slate-400">Sales distribution by category</p>
            {currentSummary.categories.length === 0 ? (
              <p className="py-8 text-center text-sm text-slate-400">No category data available.</p>
            ) : (
              <div className="flex flex-col items-center gap-5">
                <div className="relative h-40 w-40">
                  <Doughnut
                    data={{
                      labels: currentSummary.categories.slice(0, 6).map((c) => c.categoryName),
                      datasets: [{
                        data: currentSummary.categories.slice(0, 6).map((c) => c.revenue),
                        backgroundColor: ['#2563eb', '#7c3aed', '#16a34a', '#ea580c', '#db2777', '#0891b2'],
                        borderWidth: 0,
                        hoverOffset: 6,
                      }],
                    }}
                    options={{
                      responsive: true,
                      maintainAspectRatio: true,
                      cutout: '72%',
                      plugins: {
                        legend: { display: false },
                        tooltip: { callbacks: { label: (ctx) => ` ${ctx.label}: ${currency(Number(ctx.raw ?? 0))}` } },
                      },
                    }}
                  />
                  <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                    <p className="text-xs font-medium text-slate-400">Total</p>
                    <p className="text-sm font-bold text-slate-900">{currency(currentSummary.totalSales)}</p>
                  </div>
                </div>
                <div className="w-full space-y-1.5">
                  {currentSummary.categories.slice(0, 5).map((cat, i) => {
                    const dotColors = ['bg-blue-500', 'bg-violet-500', 'bg-green-500', 'bg-orange-500', 'bg-pink-500']
                    const pct = currentSummary.totalSales > 0 ? (cat.revenue / currentSummary.totalSales) * 100 : 0
                    return (
                      <div key={cat.categoryId} className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className={`h-2 w-2 shrink-0 rounded-full ${dotColors[i]}`}/>
                          <span className="truncate text-xs text-slate-600">{cat.categoryName}</span>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <span className="text-xs font-semibold text-slate-900">{currency(cat.revenue)}</span>
                          <span className="text-xs text-slate-400">({pct.toFixed(0)}%)</span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Sales by Condition */}
          <div className="rounded-xl border border-slate-100 bg-white p-3 shadow-sm">
            <h3 className="text-sm font-bold text-slate-900">Sales by Condition</h3>
            <p className="mt-0.5 mb-3 text-xs text-slate-400">Breakdown by item condition</p>
            {salesByCondition.total === 0 ? (
              <p className="py-8 text-center text-sm text-slate-400">No condition data available.</p>
            ) : (
              <div className="flex flex-col items-center gap-5">
                <div className="relative h-40 w-40">
                  <Doughnut
                    data={{
                      labels: ['New', 'Refurbished'],
                      datasets: [{
                        data: [salesByCondition.new, salesByCondition.refurbished],
                        backgroundColor: ['#2563eb', '#16a34a'],
                        borderWidth: 0,
                        hoverOffset: 6,
                      }],
                    }}
                    options={{
                      responsive: true,
                      maintainAspectRatio: true,
                      cutout: '72%',
                      plugins: {
                        legend: { display: false },
                        tooltip: { callbacks: { label: (ctx) => ` ${ctx.label}: ${currency(Number(ctx.raw ?? 0))}` } },
                      },
                    }}
                  />
                  <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                    <p className="text-xs font-medium text-slate-400">{salesByCondition.total > 0 ? `${Math.round((salesByCondition.new / salesByCondition.total) * 100)}%` : '0%'}</p>
                    <p className="text-xs font-bold text-slate-900">New</p>
                  </div>
                </div>
                <div className="w-full space-y-2.5">
                  {([{ label: 'New', value: salesByCondition.new, color: 'bg-blue-500' }, { label: 'Refurbished', value: salesByCondition.refurbished, color: 'bg-green-500' }]).map(({ label, value, color }) => {
                    const pct = salesByCondition.total > 0 ? (value / salesByCondition.total) * 100 : 0
                    return (
                      <div key={label} className="space-y-1">
                        <div className="flex justify-between text-xs">
                          <span className="flex items-center gap-1.5">
                            <span className={`h-2 w-2 rounded-full ${color}`}/>
                            {label}
                          </span>
                          <span className="font-semibold text-slate-900">{currency(value)} ({pct.toFixed(0)}%)</span>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
                          <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }}/>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Reservation Activity */}
          <div className="rounded-xl border border-slate-100 bg-white p-3 shadow-sm">
            <div className="mb-3 flex items-start justify-between">
              <div>
                <h3 className="text-sm font-bold text-slate-900">Reservation Activity</h3>
                <p className="mt-0.5 text-xs text-slate-400">{getRangeLabel(timeRangePreset)}</p>
              </div>
              <span className="text-xl font-bold text-slate-900">{reservationActivity.total}</span>
            </div>
            {reservationActivity.total === 0 ? (
              <p className="py-6 text-center text-sm text-slate-400">No reservations for this period.</p>
            ) : (
              <div className="space-y-4">
                <div className="mx-auto h-32 w-32">
                  <Doughnut
                    data={{
                      labels: ['Active', 'Completed', 'Cancelled', 'Expired'],
                      datasets: [{
                        data: [reservationActivity.counts.Active, reservationActivity.counts.Completed, reservationActivity.counts.Cancelled, reservationActivity.counts.Expired],
                        backgroundColor: [RESERVATION_STATUS_COLORS.Active, RESERVATION_STATUS_COLORS.Completed, RESERVATION_STATUS_COLORS.Cancelled, RESERVATION_STATUS_COLORS.Expired],
                        borderWidth: 0,
                        hoverOffset: 4,
                      }],
                    }}
                    options={{
                      responsive: true,
                      maintainAspectRatio: true,
                      cutout: '72%',
                      plugins: {
                        legend: { display: false },
                        tooltip: {
                          callbacks: {
                            label: (ctx) => {
                              const count = Number(ctx.raw ?? 0)
                              const pct = reservationActivity.total > 0 ? Math.round((count / reservationActivity.total) * 100) : 0
                              return ` ${ctx.label}: ${count} (${pct}%)`
                            },
                          },
                        },
                      },
                    }}
                  />
                </div>
                <div className="space-y-1.5">
                  {(['Active', 'Completed', 'Cancelled', 'Expired'] as ReservationRecord['status'][]).map((status) => {
                    const count = reservationActivity.counts[status]
                    const pct = reservationActivity.total > 0 ? Math.round((count / reservationActivity.total) * 100) : 0
                    return (
                      <div key={status} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-1.5">
                        <div className="flex items-center gap-2">
                          <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: RESERVATION_STATUS_COLORS[status] }}/>
                          <span className="text-xs text-slate-600">{status}</span>
                        </div>
                        <div className="flex items-baseline gap-1.5">
                          <span className="text-xs font-semibold text-slate-900">{count}</span>
                          <span className="text-xs text-slate-400">{pct}%</span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ── DATA TABLES ROW ──────────────────────────────────────────────── */}
        <div className="grid grid-cols-1 gap-2 xl:grid-cols-[2fr_1fr_1fr]">

          {/* Top Categories */}
          <div className="rounded-xl border border-slate-100 bg-white p-3 shadow-sm">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-slate-900">Top Categories</h3>
                <p className="mt-0.5 text-xs text-slate-400">Ranked by sales amount</p>
              </div>
              <button
                type="button"
                onClick={() => setOpenModal('top')}
                className="text-xs font-semibold text-blue-600 hover:text-blue-700 transition"
              >
                View all →
              </button>
            </div>
            {currentSummary.categories.length === 0 ? (
              <p className="py-6 text-center text-sm text-slate-400">No category sales found.</p>
            ) : (
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-100">
                    <th className="pb-2 text-left text-xs font-semibold text-slate-400">#</th>
                    <th className="pb-2 text-left text-xs font-semibold text-slate-400">Category</th>
                    <th className="pb-2 text-right text-xs font-semibold text-slate-400">Qty Sold</th>
                    <th className="pb-2 text-right text-xs font-semibold text-slate-400">Sales Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {currentSummary.categories.slice(0, 6).map((row, i) => (
                    <tr key={row.categoryId} className="hover:bg-slate-50 transition-colors">
                      <td className="py-2.5 text-xs text-slate-400">{i + 1}</td>
                      <td className="py-2.5 text-sm font-medium text-slate-900">{row.categoryName}</td>
                      <td className="py-2.5 text-right text-sm text-slate-600">{compactNumber.format(row.itemsSold)}</td>
                      <td className="py-2.5 text-right text-sm font-semibold text-slate-900">{currency(row.revenue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Top Products */}
          <div className="rounded-xl border border-slate-100 bg-white p-3 shadow-sm">
            <div className="mb-3">
              <h3 className="text-sm font-bold text-slate-900">Top Products</h3>
              <p className="mt-0.5 text-xs text-slate-400">Best performing products</p>
            </div>
            {topProducts.length === 0 ? (
              <p className="py-6 text-center text-sm text-slate-400">No product data found.</p>
            ) : (
              <div className="space-y-2">
                {topProducts.map((product, i) => (
                  <div key={product.name} className="flex items-center gap-3 rounded-xl bg-slate-50 px-3 py-2.5 hover:bg-slate-100 transition-colors">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white text-xs font-bold text-slate-500 shadow-sm">{i + 1}</span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-semibold text-slate-900">{product.name}</p>
                      <p className="text-xs text-slate-400">{compactNumber.format(product.qty)} sold</p>
                    </div>
                    <span className="shrink-0 text-xs font-bold text-slate-900">{currency(product.revenue)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Inventory by Category */}
          <div className="rounded-xl border border-slate-100 bg-white p-3 shadow-sm">
            <div className="mb-3">
              <h3 className="text-sm font-bold text-slate-900">Inventory by Category</h3>
              <p className="mt-0.5 text-xs text-slate-400">Current stock snapshot</p>
            </div>
            {inventorySummary.length === 0 ? (
              <p className="py-6 text-center text-sm text-slate-400">No inventory data found.</p>
            ) : (
              <div className="space-y-2">
                {inventorySummary.slice(0, 6).map((row) => (
                  <div key={row.categoryName} className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2.5">
                    <span className="truncate text-xs font-medium text-slate-700">{row.categoryName}</span>
                    <span className="ml-2 shrink-0 rounded-full bg-blue-50 px-2 py-0.5 text-xs font-semibold text-blue-700">{compactNumber.format(row.stock)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ── PREDICTIVE ANALYTICS + EXECUTIVE SUMMARY ─────────────────────── */}
        <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">

          {/* Predictive Analytics — modern stat cards */}
          <div className="rounded-xl border border-slate-100 bg-white p-3 shadow-sm">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-slate-900">Predictive Analytics</h3>
                <p className="mt-0.5 text-xs text-slate-400">AI-powered category demand forecast</p>
              </div>
              <span className="inline-flex items-center rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-semibold text-indigo-700">
                {predictiveSummary.forecastWindow}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl bg-gradient-to-br from-blue-50 to-blue-100/40 p-4">
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-blue-500">🔥 Fast-Moving</p>
                <p className="truncate text-base font-bold text-slate-900">{predictiveSummary.projectedFastMovingCategory}</p>
                <p className="mt-0.5 text-xs text-slate-500">Top forecast pick</p>
              </div>
              <div className="rounded-xl bg-gradient-to-br from-green-50 to-green-100/40 p-4">
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-green-600">Forecast Window</p>
                <p className="text-base font-bold text-slate-900">{predictiveSummary.forecastWindow}</p>
                <p className="mt-0.5 text-xs text-slate-500">{trendSeries.granularity === 'day' ? 'Day granularity' : 'Month granularity'}</p>
              </div>
              <div className="rounded-xl bg-gradient-to-br from-violet-50 to-violet-100/40 p-4">
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-violet-600">Projected Revenue</p>
                <p className="text-base font-bold text-slate-900">{currency(predictiveSummary.projectedCategoryRevenue)}</p>
                <p className="mt-0.5 text-xs text-slate-500">for top category</p>
              </div>
              <div className="rounded-xl bg-gradient-to-br from-orange-50 to-orange-100/40 p-4">
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-orange-600">Projected Units</p>
                <p className="text-base font-bold text-slate-900">{compactNumber.format(Math.round(predictiveSummary.projectedCategoryItems))}</p>
                <p className="mt-0.5 text-xs text-slate-500">items forecast</p>
              </div>
            </div>
            <p className="mt-4 text-xs text-slate-400">Prediction is based on past sales transactions and category movement.</p>
          </div>

          {/* Executive Summary — status cards */}
          <div className="rounded-xl border border-slate-100 bg-white p-3 shadow-sm">
            <div className="mb-4">
              <h3 className="text-sm font-bold text-slate-900">Executive Summary</h3>
              <p className="mt-0.5 text-xs text-slate-400">Key insights for {getRangeLabel(timeRangePreset).toLowerCase()}</p>
            </div>
            <div className="space-y-2.5">
              <div className="flex items-start gap-3 rounded-xl bg-slate-50 px-4 py-3">
                <span className="mt-0.5 text-base">📊</span>
                <div>
                  <p className="text-xs font-semibold text-slate-600">Total Revenue</p>
                  <p className="text-sm font-bold text-slate-900">{currency(currentSummary.totalSales)}</p>
                </div>
              </div>
              <div className="flex items-start gap-3 rounded-xl bg-slate-50 px-4 py-3">
                <span className="mt-0.5 text-base">📦</span>
                <div>
                  <p className="text-xs font-semibold text-slate-600">Items Sold</p>
                  <p className="text-sm font-bold text-slate-900">
                    {compactNumber.format(currentSummary.itemsSold)} units across {filteredSales.length} transaction{filteredSales.length !== 1 ? 's' : ''}
                  </p>
                </div>
              </div>
              {currentSummary.topCategory && (
                <div className="flex items-start gap-3 rounded-xl bg-green-50 px-4 py-3">
                  <span className="mt-0.5 text-base">🔥</span>
                  <div>
                    <p className="text-xs font-semibold text-green-700">Top Category</p>
                    <p className="text-sm font-bold text-slate-900">
                      {currentSummary.topCategory.categoryName}{' '}
                      <span className="text-xs font-normal text-slate-500">
                        ({((currentSummary.topCategory.revenue / Math.max(1, currentSummary.totalSales)) * 100).toFixed(0)}% of sales)
                      </span>
                    </p>
                  </div>
                </div>
              )}
              {comparisonMetrics.totalSales[0] && comparisonMetrics.totalSales[0].change !== null && (
                <div className={`flex items-start gap-3 rounded-xl px-4 py-3 ${comparisonMetrics.totalSales[0].change >= 0 ? 'bg-green-50' : 'bg-red-50'}`}>
                  <span className="mt-0.5 text-base">{comparisonMetrics.totalSales[0].change >= 0 ? '✅' : '⚠️'}</span>
                  <div>
                    <p className={`text-xs font-semibold ${comparisonMetrics.totalSales[0].change >= 0 ? 'text-green-700' : 'text-red-600'}`}>Sales Trend</p>
                    <p className="text-sm text-slate-700">
                      {comparisonMetrics.totalSales[0].change >= 0 ? 'Increasing' : 'Decreasing'} by{' '}
                      <span className="font-bold">{percentFormatter.format(Math.abs(comparisonMetrics.totalSales[0].change))}%</span>{' '}
                      vs last period
                    </p>
                  </div>
                </div>
              )}
              {aiForecast?.canForecast && aiForecast.aiForecast && (
                <div className="flex items-start gap-3 rounded-xl bg-violet-50 px-4 py-3">
                  <span className="mt-0.5 text-base">🧠</span>
                  <div>
                    <p className="text-xs font-semibold text-violet-700">AI Forecast</p>
                    <p className="text-sm text-slate-700">
                      {aiForecast.aiForecast.insight.length > 120
                        ? `${aiForecast.aiForecast.insight.slice(0, 120)}…`
                        : aiForecast.aiForecast.insight}
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── FOOTER NOTE ──────────────────────────────────────────────────── */}
        <div className="flex items-center gap-2 rounded-xl bg-blue-50 px-4 py-3 text-xs text-blue-600">
          <svg className="h-4 w-4 shrink-0" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd"/>
          </svg>
          All data is based on the selected date range and filters.
        </div>

      </div>

      {/* Modal */}
      {modalConfig ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
          <div className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-100 px-6 py-4">
              <h2 className="text-base font-bold text-slate-900">{modalConfig.title}</h2>
              <button
                type="button"
                onClick={() => setOpenModal(null)}
                className="rounded-lg bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-200 transition"
              >
                Close
              </button>
            </div>
            <div className="overflow-y-auto p-6">
              <AnalyticsTable columns={modalConfig.columns} rows={modalConfig.rows} />
            </div>
          </div>
        </div>
      ) : null}
    </main>
  )
}
