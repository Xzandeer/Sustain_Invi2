'use client'

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
import { collection, onSnapshot } from 'firebase/firestore'
import ProtectedRoute from '@/components/shared/ProtectedRoute'
import { db } from '@/lib/firebase'
import AnalyticsCard from '@/components/analytics/AnalyticsCard'
import AnalyticsBadge from '@/components/analytics/AnalyticsBadge'
import AnalyticsTable from '@/components/analytics/AnalyticsTable'
import type { InventoryRecord } from '@/lib/server/salesInventoryMetrics'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, ArcElement, Tooltip, Legend)

type SaleItemCondition = 'New' | 'Refurbished'
type AnalyticsModalType = 'top' | 'products' | null
type TimeRangePreset = 'this-week' | 'this-month' | 'last-month' | 'last-6-months' | 'this-year' | 'custom'

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

export default function AnalyticsPage() {
  return (
    <ProtectedRoute>
      <AnalyticsContent />
    </ProtectedRoute>
  )
}

function AnalyticsContent() {
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

  useEffect(() => {
    const unsubscribeCategories = onSnapshot(collection(db, 'categories'), (snapshot) => {
      const rows = snapshot.docs
        .map((categoryDoc) => {
          const data = categoryDoc.data() as Record<string, unknown>
          return {
            id: categoryDoc.id,
            name: typeof data.name === 'string' && data.name.trim() ? data.name : categoryDoc.id,
          }
        })
        .sort((a, b) => a.name.localeCompare(b.name))
      setCategories(rows)
    })

    const unsubscribeSales = onSnapshot(collection(db, 'sales'), (snapshot) => {
      const rows: SaleRecord[] = snapshot.docs.map((saleDoc) => {
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
      setSales(rows)
    })

    const unsubscribeInventory = onSnapshot(collection(db, 'inventory'), (snapshot) => {
      const rows: InventoryRecord[] = snapshot.docs
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
      setInventory(rows)
    })

    // Listen to reservations collection for the Reservation Activity panel
    const unsubscribeReservations = onSnapshot(collection(db, 'reservations'), (snapshot) => {
      const rows: ReservationRecord[] = snapshot.docs.map((resDoc) => {
        const data = resDoc.data() as Record<string, unknown>
        // Normalize status — default to 'Active' if unrecognized
        const rawStatus = typeof data.status === 'string' ? data.status : ''
        const status = (['Active', 'Completed', 'Cancelled', 'Expired'] as const).includes(
          rawStatus as ReservationRecord['status']
        )
          ? (rawStatus as ReservationRecord['status'])
          : 'Active'
        return {
          id: resDoc.id,
          status,
          createdAt: toDate(data.createdAt),
        }
      })
      setReservations(rows)
    })

    return () => {
      unsubscribeCategories()
      unsubscribeSales()
      unsubscribeInventory()
      unsubscribeReservations()
    }
  }, [])

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

  // Top individual products ranked by revenue
  const topProducts = useMemo(() => {
    const productMap = new Map<string, { itemsSold: number; revenue: number }>()
    filteredSales.forEach((sale) => {
      sale.items.forEach((item) => {
        const current = productMap.get(item.name) ?? { itemsSold: 0, revenue: 0 }
        current.itemsSold += item.quantity
        current.revenue += item.quantity * item.price
        productMap.set(item.name, current)
      })
    })
    return Array.from(productMap.entries())
      .map(([name, data]) => ({ name, ...data }))
      .sort((a, b) => b.revenue - a.revenue)
  }, [filteredSales])

  // Rows for the products modal
  const allProductRows = useMemo(
    () =>
      topProducts.map((row, index) => ({
        key: row.name,
        cells: [
          <span key={`${row.name}-rank`} className="font-medium text-slate-900">{index + 1}</span>,
          <span key={`${row.name}-name`} className="font-medium text-slate-900">{row.name}</span>,
          <span key={`${row.name}-items`} className="block text-right">{compactNumber.format(row.itemsSold)}</span>,
          <span key={`${row.name}-rev`} className="block text-right">{currency(row.revenue)}</span>,
        ],
      })),
    [topProducts]
  )

  const modalConfig = useMemo(() => {
    if (openModal === 'top') {
      return {
        title: `Top Categories — ${getRangeLabel(timeRangePreset)}`,
        columns: [
          { header: '#' },
          { header: 'Category' },
          { header: 'Qty Sold', className: 'text-right' },
          { header: 'Sales Amount', className: 'text-right' },
        ],
        rows: allTopCategoryRows,
      }
    }
    if (openModal === 'products') {
      return {
        title: `Top Products — ${getRangeLabel(timeRangePreset)}`,
        columns: [
          { header: '#' },
          { header: 'Product' },
          { header: 'Qty Sold', className: 'text-right' },
          { header: 'Sales', className: 'text-right' },
        ],
        rows: allProductRows,
      }
    }
    return null
  }, [allTopCategoryRows, allProductRows, openModal, timeRangePreset])


  // ── New computed values for redesigned analytics page ─────────────────────

  const transactionCount = filteredSales.length
  const previousTransactionCount = filteredPreviousPeriodSales.length
  const averageOrderValue = transactionCount > 0 ? currentSummary.totalSales / transactionCount : 0
  const previousAverageOrderValue =
    previousTransactionCount > 0 ? previousSummary.totalSales / previousTransactionCount : 0
  const avgOrderValueChange = calculatePercentChange(averageOrderValue, previousAverageOrderValue)
  const transactionCountChange = calculatePercentChange(transactionCount, previousTransactionCount)

  const handleResetFilters = () => {
    setTimeRangePreset('this-month')
    setCustomStartDate('')
    setCustomEndDate('')
    setSelectedCategory('All Categories')
    setSelectedCondition('All Conditions')
    setDateRangeError('')
  }

  const headerDateLabel = useMemo(() => {
    const fmt = (d: Date) =>
      d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })
    return `${fmt(activeRange.start)} – ${fmt(activeRange.end)}`
  }, [activeRange])

  const previousPeriodLabel = useMemo(() => {
    const fmt = (d: Date) => d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric' })
    return `vs ${fmt(previousPeriodRange.start)} – ${fmt(previousPeriodRange.end)}`
  }, [previousPeriodRange])

  // Revenue breakdown by item condition (New vs Refurbished)
  const salesByCondition = useMemo(() => {
    const breakdown = { New: 0, Refurbished: 0 }
    filteredSales.forEach((sale) => {
      sale.items.forEach((item) => {
        if (item.condition === 'Refurbished') {
          breakdown.Refurbished += item.quantity * item.price
        } else {
          breakdown.New += item.quantity * item.price
        }
      })
    })
    const total = breakdown.New + breakdown.Refurbished
    return {
      New: breakdown.New,
      Refurbished: breakdown.Refurbished,
      total,
      newPct: total > 0 ? Math.round((breakdown.New / total) * 100) : 0,
      refurbishedPct: total > 0 ? Math.round((breakdown.Refurbished / total) * 100) : 0,
    }
  }, [filteredSales])

  // Category demand donut — top 5 categories + Others bucket
  const CATEGORY_CHART_COLORS = ['#2563eb', '#16a34a', '#d97706', '#7c3aed', '#6b7280', '#94a3b8']
  const categoryDemandData = useMemo(() => {
    const top5 = currentSummary.categories.slice(0, 5)
    const othersRevenue = currentSummary.categories.slice(5).reduce((sum, c) => sum + c.revenue, 0)
    const total = currentSummary.totalSales
    const items = [
      ...top5.map((c, i) => ({
        label: c.categoryName,
        revenue: c.revenue,
        color: CATEGORY_CHART_COLORS[i] ?? '#6b7280',
        pct: total > 0 ? Math.round((c.revenue / total) * 100) : 0,
      })),
      ...(othersRevenue > 0
        ? [{ label: 'Others', revenue: othersRevenue, color: '#94a3b8', pct: total > 0 ? Math.round((othersRevenue / total) * 100) : 0 }]
        : []),
    ]
    return { items, total }
  }, [currentSummary])


  // Demand level label based on projected vs current revenue ratio
  const projectedDemandLevel = useMemo(() => {
    const projected = predictiveSummary.projectedSales
    const current = currentSummary.totalSales
    if (current === 0) return projected > 0 ? 'High' : 'Low'
    const ratio = projected / current
    if (ratio >= 0.9) return 'High'
    if (ratio >= 0.5) return 'Medium'
    return 'Low'
  }, [predictiveSummary.projectedSales, currentSummary.totalSales])


  return (
    <main className="min-h-[calc(100vh-64px)] bg-slate-50 px-3 py-3 sm:px-4 sm:py-4">
      <div className="mx-auto max-w-[1400px] space-y-3">

        {/* ── Page Header ── */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
              </svg>
            </div>
            <div>
              <h1 className="text-lg font-bold text-slate-900 sm:text-2xl">Analytics</h1>
              <p className="mt-0.5 text-sm text-slate-500">
                Analyze sales trends and predict category demand for surplus inventory.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm">
            <svg className="h-4 w-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
            </svg>
            <span className="font-medium">{headerDateLabel}</span>
          </div>
        </div>

        {/* ── Filters ── */}
        <div className="rounded-2xl border border-slate-200 bg-white p-3 sm:p-4 shadow-sm">
          <h2 className="mb-2 text-xs font-semibold text-slate-700">Filters</h2>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Time Range</label>
              <select
                value={timeRangePreset}
                onChange={(event) => setTimeRangePreset(event.target.value as TimeRangePreset)}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 focus:border-blue-500 focus:outline-none"
              >
                <option value="this-week">This Week</option>
                <option value="this-month">This Month</option>
                <option value="last-month">Last Month</option>
                <option value="last-6-months">Last 6 Months</option>
                <option value="this-year">This Year</option>
                <option value="custom">Custom Range</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Start Date</label>
              <input
                type="date"
                value={timeRangePreset === 'custom' ? customStartDate : formatDateInput(activeRange.start)}
                max={timeRangePreset === 'custom' && customEndDate ? customEndDate : undefined}
                onChange={(event) => handleCustomStartDateChange(event.target.value)}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 focus:border-blue-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">End Date</label>
              <input
                type="date"
                value={timeRangePreset === 'custom' ? customEndDate : formatDateInput(activeRange.end)}
                min={timeRangePreset === 'custom' && customStartDate ? customStartDate : undefined}
                onChange={(event) => handleCustomEndDateChange(event.target.value)}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 focus:border-blue-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Category</label>
              <select
                value={selectedCategory}
                onChange={(event) => setSelectedCategory(event.target.value)}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 focus:border-blue-500 focus:outline-none"
              >
                <option value="All Categories">All Categories</option>
                {availableCategoryIds.map((id) => (
                  <option key={id} value={id}>{categoryNameMap[id] ?? id}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Condition</label>
              <select
                value={selectedCondition}
                onChange={(event) =>
                  setSelectedCondition(
                    event.target.value === 'Refurbished' ? 'Refurbished'
                      : event.target.value === 'New' ? 'New'
                      : 'All Conditions'
                  )
                }
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 focus:border-blue-500 focus:outline-none"
              >
                <option value="All Conditions">All Conditions</option>
                <option value="New">New</option>
                <option value="Refurbished">Refurbished</option>
              </select>
            </div>
          </div>
          {dateRangeError ? <p className="mt-2 text-xs text-red-500">{dateRangeError}</p> : null}
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              className="flex items-center gap-1.5 rounded-lg bg-[#1e3a5f] px-4 py-2 text-sm font-medium text-white transition hover:bg-[#162d4a]"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2a1 1 0 01-.293.707L13 13.414V19a1 1 0 01-.553.894l-4 2A1 1 0 017 21v-7.586L3.293 6.707A1 1 0 013 6V4z" />
              </svg>
              Apply Filters
            </button>
            <button
              type="button"
              onClick={handleResetFilters}
              className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              Reset Filters
            </button>
          </div>
        </div>

        {/* ── 5 KPI Cards ── */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">

          {/* Total Sales */}
          <div className="rounded-2xl border border-slate-200 bg-white p-3 sm:p-4 shadow-sm">
            <div className="rounded-xl bg-blue-50 p-2.5 w-fit">
              <svg className="h-5 w-5 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <p className="mt-2 text-xs font-medium text-slate-500">Total Sales</p>
            <p className="mt-0.5 text-lg font-bold text-slate-900 sm:text-2xl">{currency(currentSummary.totalSales)}</p>
            {comparisonMetrics.totalSales[0] ? (
              <p className={`mt-1.5 text-xs font-medium ${comparisonMetrics.totalSales[0].change === null ? 'text-slate-400' : comparisonMetrics.totalSales[0].change >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                {comparisonMetrics.totalSales[0].change === null ? '—' : comparisonMetrics.totalSales[0].change >= 0 ? '↑' : '↓'}{' '}
                {comparisonMetrics.totalSales[0].change === null ? 'No prior data' : `${percentFormatter.format(Math.abs(comparisonMetrics.totalSales[0].change))}%`}
                <span className="ml-1 font-normal text-slate-400">{previousPeriodLabel}</span>
              </p>
            ) : null}
          </div>

          {/* Items Sold */}
          <div className="rounded-2xl border border-slate-200 bg-white p-3 sm:p-4 shadow-sm">
            <div className="rounded-xl bg-green-50 p-2.5 w-fit">
              <svg className="h-5 w-5 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" />
              </svg>
            </div>
            <p className="mt-2 text-xs font-medium text-slate-500">Items Sold</p>
            <p className="mt-0.5 text-lg font-bold text-slate-900 sm:text-2xl">{compactNumber.format(currentSummary.itemsSold)}</p>
            {comparisonMetrics.itemsSold[0] ? (
              <p className={`mt-1.5 text-xs font-medium ${comparisonMetrics.itemsSold[0].change === null ? 'text-slate-400' : comparisonMetrics.itemsSold[0].change >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                {comparisonMetrics.itemsSold[0].change === null ? '—' : comparisonMetrics.itemsSold[0].change >= 0 ? '↑' : '↓'}{' '}
                {comparisonMetrics.itemsSold[0].change === null ? 'No prior data' : `${percentFormatter.format(Math.abs(comparisonMetrics.itemsSold[0].change))}%`}
                <span className="ml-1 font-normal text-slate-400">{previousPeriodLabel}</span>
              </p>
            ) : null}
          </div>

          {/* Average Order Value */}
          <div className="rounded-2xl border border-slate-200 bg-white p-3 sm:p-4 shadow-sm">
            <div className="rounded-xl bg-orange-50 p-2.5 w-fit">
              <svg className="h-5 w-5 text-orange-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
              </svg>
            </div>
            <p className="mt-2 text-xs font-medium text-slate-500">Average Order Value</p>
            <p className="mt-0.5 text-lg font-bold text-slate-900 sm:text-2xl">{currency(averageOrderValue)}</p>
            <p className={`mt-1.5 text-xs font-medium ${avgOrderValueChange === null ? 'text-slate-400' : avgOrderValueChange >= 0 ? 'text-green-600' : 'text-red-500'}`}>
              {avgOrderValueChange === null ? '—' : avgOrderValueChange >= 0 ? '↑' : '↓'}{' '}
              {avgOrderValueChange === null ? 'No prior data' : `${percentFormatter.format(Math.abs(avgOrderValueChange))}%`}
              <span className="ml-1 font-normal text-slate-400">{previousPeriodLabel}</span>
            </p>
          </div>

          {/* Transactions */}
          <div className="rounded-2xl border border-slate-200 bg-white p-3 sm:p-4 shadow-sm">
            <div className="rounded-xl bg-purple-50 p-2.5 w-fit">
              <svg className="h-5 w-5 text-purple-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
              </svg>
            </div>
            <p className="mt-2 text-xs font-medium text-slate-500">Transactions</p>
            <p className="mt-0.5 text-lg font-bold text-slate-900 sm:text-2xl">{compactNumber.format(transactionCount)}</p>
            <p className={`mt-1.5 text-xs font-medium ${transactionCountChange === null ? 'text-slate-400' : transactionCountChange >= 0 ? 'text-green-600' : 'text-red-500'}`}>
              {transactionCountChange === null ? '—' : transactionCountChange >= 0 ? '↑' : '↓'}{' '}
              {transactionCountChange === null ? 'No prior data' : `${percentFormatter.format(Math.abs(transactionCountChange))}%`}
              <span className="ml-1 font-normal text-slate-400">{previousPeriodLabel}</span>
            </p>
          </div>

          {/* Projected Demand */}
          <div className="rounded-2xl border border-slate-200 bg-white p-3 sm:p-4 shadow-sm">
            <div className="rounded-xl bg-pink-50 p-2.5 w-fit">
              <svg className="h-5 w-5 text-pink-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
              </svg>
            </div>
            <p className="mt-2 text-xs font-medium text-slate-500">Projected Demand</p>
            <p className="mt-0.5 text-xs text-slate-400">
              Next {forecastSeries.steps} {trendSeries.granularity === 'day' ? 'days' : 'periods'}
            </p>
            <p className={`mt-0.5 text-lg font-bold sm:text-2xl ${projectedDemandLevel === 'High' ? 'text-pink-500' : projectedDemandLevel === 'Medium' ? 'text-amber-500' : 'text-slate-500'}`}>
              {projectedDemandLevel}
            </p>
            {categoryForecast.topCategory ? (
              <p className="mt-0.5 text-xs text-slate-400">
                for {categoryForecast.topCategory.categoryName} category
              </p>
            ) : null}
          </div>
        </div>

        {/* ── Sales Trend + Category Demand ── */}
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">

          {/* Sales Trend chart */}
          <div className="rounded-2xl border border-slate-200 bg-white p-3 sm:p-4 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="font-semibold text-slate-900">Sales Trend</p>
                <p className="text-xs text-slate-400">
                  {trendSeries.granularity === 'day' ? 'Daily' : 'Monthly'} sales from{' '}
                  {formatDayLabel(activeRange.start)} – {formatDayLabel(activeRange.end)}
                </p>
              </div>
              <div className="flex gap-4 text-xs text-slate-500">
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-px w-5 border-t-2 border-[#0f4c81]" /> Actual Sales
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-px w-5 border-t-2 border-dashed border-amber-400" /> Forecast Sales
                </span>
              </div>
            </div>
            <div className="mt-4 h-64">
              <Line
                data={{
                  labels: forecastSeries.labels,
                  datasets: [
                    {
                      label: 'Actual Sales',
                      data: forecastSeries.actualValues,
                      fill: true,
                      borderColor: '#0f4c81',
                      backgroundColor: 'rgba(15,76,129,0.07)',
                      borderWidth: 2,
                      pointRadius: trendSeries.hasSinglePoint ? 5 : 3,
                      pointHoverRadius: 5,
                      tension: 0.35,
                    },
                    {
                      label: 'Forecast',
                      data: forecastSeries.forecastValues,
                      borderColor: '#f59e0b',
                      backgroundColor: 'transparent',
                      borderWidth: 2,
                      borderDash: [6, 5],
                      pointRadius: 0,
                      pointHoverRadius: 4,
                      tension: 0.35,
                      spanGaps: true,
                    },
                  ],
                }}
                options={{
                  responsive: true,
                  maintainAspectRatio: false,
                  plugins: {
                    legend: { display: false },
                    tooltip: {
                      callbacks: {
                        label: (ctx) => `${ctx.dataset.label}: ${currency(Number(ctx.parsed.y ?? 0))}`,
                      },
                    },
                  },
                  scales: {
                    x: { grid: { display: false }, ticks: { font: { size: 11 } } },
                    y: {
                      beginAtZero: true,
                      ticks: {
                        font: { size: 11 },
                        callback: (value) => `₱${Number(value).toLocaleString('en-PH')}`,
                      },
                    },
                  },
                }}
              />
            </div>
            <p className="mt-2 text-xs text-slate-400">{forecastSeries.note}</p>
          </div>

          {/* Category Demand donut */}
          <div className="rounded-2xl border border-slate-200 bg-white p-3 sm:p-4 shadow-sm">
            <p className="font-semibold text-slate-900">Category Demand Analysis</p>
            <p className="text-xs text-slate-400">Sales distribution by category</p>
            <div className="mt-4 flex items-center gap-5">
              <div className="relative h-48 w-48 shrink-0">
                <Doughnut
                  data={{
                    labels: categoryDemandData.items.map((item) => item.label),
                    datasets: [{
                      data: categoryDemandData.items.map((item) => item.revenue),
                      backgroundColor: categoryDemandData.items.map((item) => item.color),
                      borderWidth: 0,
                      hoverOffset: 4,
                    }],
                  }}
                  options={{
                    responsive: true,
                    maintainAspectRatio: true,
                    cutout: '70%',
                    plugins: {
                      legend: { display: false },
                      tooltip: { callbacks: { label: (ctx) => ` ${ctx.label}: ${currency(Number(ctx.raw ?? 0))}` } },
                    },
                  }}
                />
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-xs text-slate-400">Total</span>
                  <span className="text-sm font-bold text-slate-900">{currency(categoryDemandData.total)}</span>
                </div>
              </div>
              <div className="min-w-0 flex-1 space-y-2.5">
                {categoryDemandData.items.length === 0 ? (
                  <p className="text-sm text-slate-400">No sales for this period.</p>
                ) : (
                  categoryDemandData.items.map((item, idx) => (
                    <div key={`${item.label}-${idx}`} className="flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: item.color }} />
                        <span className="truncate text-sm text-slate-700">{item.label}</span>
                      </div>
                      <div className="shrink-0 text-right text-sm">
                        <span className="font-medium text-slate-900">{currency(item.revenue)}</span>
                        <span className="ml-1 text-xs text-slate-400">({item.pct}%)</span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ── Sales by Condition | Top Categories | Top Products ── */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">

          {/* Sales by Condition donut */}
          <div className="rounded-2xl border border-slate-200 bg-white p-3 sm:p-4 shadow-sm">
            <p className="font-semibold text-slate-900">Sales by Condition</p>
            <p className="text-xs text-slate-400">Breakdown of sales by item condition</p>
            <div className="mt-4 flex items-center gap-4">
              <div className="relative h-40 w-40 shrink-0">
                <Doughnut
                  data={{
                    labels: ['New', 'Refurbished'],
                    datasets: [{
                      data: [salesByCondition.New || 0.001, salesByCondition.Refurbished || 0],
                      backgroundColor: ['#2563eb', '#16a34a'],
                      borderWidth: 0,
                      hoverOffset: 4,
                    }],
                  }}
                  options={{
                    responsive: true,
                    maintainAspectRatio: true,
                    cutout: '70%',
                    plugins: {
                      legend: { display: false },
                      tooltip: { callbacks: { label: (ctx) => ` ${ctx.label}: ${currency(Number(ctx.raw ?? 0))}` } },
                    },
                  }}
                />
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
                  <span className="text-base font-bold text-slate-900">{salesByCondition.newPct}%</span>
                  <span className="text-xs text-slate-400">New</span>
                </div>
              </div>
              <div className="space-y-3">
                <div className="flex items-start gap-2">
                  <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-blue-600" />
                  <div>
                    <p className="text-sm font-medium text-slate-700">New</p>
                    <p className="text-xs text-slate-500">{currency(salesByCondition.New)} ({salesByCondition.newPct}%)</p>
                  </div>
                </div>
                <div className="flex items-start gap-2">
                  <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-green-600" />
                  <div>
                    <p className="text-sm font-medium text-slate-700">Refurbished</p>
                    <p className="text-xs text-slate-500">{currency(salesByCondition.Refurbished)} ({salesByCondition.refurbishedPct}%)</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Top Categories table */}
          <div className="rounded-2xl border border-slate-200 bg-white p-3 sm:p-4 shadow-sm">
            <div className="mb-3 flex items-start justify-between">
              <div>
                <p className="font-semibold text-slate-900">Top Categories</p>
                <p className="text-xs text-slate-400">Ranked by sales amount</p>
              </div>
            </div>
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-100">
                  <th className="pb-2 text-left text-xs font-medium text-slate-400">#</th>
                  <th className="pb-2 text-left text-xs font-medium text-slate-400">Category</th>
                  <th className="pb-2 text-right text-xs font-medium text-slate-400">Qty Sold</th>
                  <th className="pb-2 text-right text-xs font-medium text-slate-400">Sales Amount</th>
                </tr>
              </thead>
              <tbody>
                {currentSummary.categories.length === 0 ? (
                  <tr><td colSpan={4} className="py-5 text-center text-xs text-slate-400">No category sales for this period.</td></tr>
                ) : (
                  currentSummary.categories.slice(0, 5).map((row, i) => (
                    <tr key={row.categoryId} className="border-b border-slate-50 hover:bg-slate-50">
                      <td className="py-2 text-xs text-slate-400">{i + 1}</td>
                      <td className="py-2 text-sm font-medium text-slate-800">{row.categoryName}</td>
                      <td className="py-2 text-right text-sm text-slate-600">{compactNumber.format(row.itemsSold)}</td>
                      <td className="py-2 text-right text-sm font-semibold text-slate-900">{currency(row.revenue)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            {currentSummary.categories.length > 5 ? (
              <button
                type="button"
                onClick={() => setOpenModal('top')}
                className="mt-3 flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-500"
              >
                View all categories
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
              </button>
            ) : null}
          </div>

          {/* Top Products table */}
          <div className="rounded-2xl border border-slate-200 bg-white p-3 sm:p-4 shadow-sm">
            <div className="mb-3">
              <p className="font-semibold text-slate-900">Top Products</p>
              <p className="text-xs text-slate-400">Best performing products</p>
            </div>
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-100">
                  <th className="pb-2 text-left text-xs font-medium text-slate-400">#</th>
                  <th className="pb-2 text-left text-xs font-medium text-slate-400">Product</th>
                  <th className="pb-2 text-right text-xs font-medium text-slate-400">Qty Sold</th>
                  <th className="pb-2 text-right text-xs font-medium text-slate-400">Sales</th>
                </tr>
              </thead>
              <tbody>
                {topProducts.length === 0 ? (
                  <tr><td colSpan={4} className="py-5 text-center text-xs text-slate-400">No products for this period.</td></tr>
                ) : (
                  topProducts.slice(0, 5).map((row, i) => (
                    <tr key={row.name} className="border-b border-slate-50 hover:bg-slate-50">
                      <td className="py-2 text-xs text-slate-400">{i + 1}</td>
                      <td className="py-2 text-sm font-medium text-slate-800">{row.name}</td>
                      <td className="py-2 text-right text-sm text-slate-600">{compactNumber.format(row.itemsSold)}</td>
                      <td className="py-2 text-right text-sm font-semibold text-slate-900">{currency(row.revenue)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            {topProducts.length > 5 ? (
              <button
                type="button"
                onClick={() => setOpenModal('products')}
                className="mt-3 flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-500"
              >
                View all products
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
              </button>
            ) : null}
          </div>
        </div>

        {/* ── Predictive Analytics | Summary ── */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">

          {/* Predictive Analytics */}
          <div className="rounded-2xl border border-slate-200 bg-white p-3 sm:p-4 shadow-sm">
            <p className="text-sm font-semibold text-blue-700">Predictive Analytics</p>
            <p className="text-xs text-slate-400">Category demand forecast</p>
            <div className="mt-4 flex items-center gap-3">
              <span className="text-4xl" role="img" aria-label="crystal ball">🔮</span>
              <div>
                <p className="text-xs text-slate-400">Fast-Moving Category</p>
                <p className="text-lg font-bold text-slate-900">
                  {categoryForecast.topCategory?.categoryName ?? 'No data'}
                </p>
              </div>
            </div>
            <div className="mt-4 space-y-2 rounded-xl bg-slate-50 p-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-slate-500">Forecast Window</span>
                <span className="font-medium text-slate-900">
                  Next {forecastSeries.steps} {trendSeries.granularity === 'day' ? 'Days' : 'Periods'}
                </span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-slate-500">Projected Revenue</span>
                <span className="font-medium text-slate-900">{currency(predictiveSummary.projectedCategoryRevenue)}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-slate-500">Projected Items Sold</span>
                <span className="font-medium text-slate-900">
                  {Math.round(predictiveSummary.projectedCategoryItems)} items
                </span>
              </div>
            </div>
            <p className="mt-3 text-xs text-slate-400">
              Prediction is based on past sales transactions and category movement.
            </p>
          </div>

          {/* Summary */}
          <div className="rounded-2xl border border-slate-200 bg-white p-3 sm:p-4 shadow-sm">
            <div className="flex items-center gap-2">
              <svg className="h-4 w-4 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
              <p className="text-sm font-semibold text-slate-900">Summary</p>
            </div>
            <div className="mt-4 space-y-3">
              <div className="flex items-start gap-2">
                <svg className="mt-0.5 h-4 w-4 shrink-0 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                <p className="text-sm text-slate-700">
                  Total sales for this period:{' '}
                  <span className="font-semibold text-slate-900">{currency(currentSummary.totalSales)}</span>
                </p>
              </div>
              <div className="flex items-start gap-2">
                <svg className="mt-0.5 h-4 w-4 shrink-0 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                <p className="text-sm text-slate-700">
                  Items sold: <span className="font-semibold text-slate-900">{compactNumber.format(currentSummary.itemsSold)}</span>
                  {comparisonMetrics.itemsSold[0]?.change !== null && comparisonMetrics.itemsSold[0]?.change !== undefined ? (
                    <span className={`ml-1 text-xs font-medium ${comparisonMetrics.itemsSold[0].change >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                      ({comparisonMetrics.itemsSold[0].change >= 0 ? '↑' : '↓'} {percentFormatter.format(Math.abs(comparisonMetrics.itemsSold[0].change))}%)
                    </span>
                  ) : null}
                </p>
              </div>
              <div className="flex items-start gap-2">
                <svg className="mt-0.5 h-4 w-4 shrink-0 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                <p className="text-sm text-slate-700">
                  Average order value:{' '}
                  <span className="font-semibold text-slate-900">{currency(averageOrderValue)}</span>
                  {avgOrderValueChange !== null ? (
                    <span className={`ml-1 text-xs font-medium ${avgOrderValueChange >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                      ({avgOrderValueChange >= 0 ? '↑' : '↓'} {percentFormatter.format(Math.abs(avgOrderValueChange))}%)
                    </span>
                  ) : null}
                </p>
              </div>
              <div className="flex items-start gap-2">
                <svg className="mt-0.5 h-4 w-4 shrink-0 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                <p className="text-sm text-slate-700">
                  Top category:{' '}
                  <span className="font-semibold text-slate-900">
                    {currentSummary.topCategory?.categoryName ?? 'None'}
                  </span>
                  {currentSummary.topCategory && categoryDemandData.total > 0 ? (
                    <span className="ml-1 text-xs text-slate-400">
                      ({Math.round((currentSummary.topCategory.revenue / categoryDemandData.total) * 100)}% of sales)
                    </span>
                  ) : null}
                </p>
              </div>
              <div className="flex items-start gap-2">
                <svg className="mt-0.5 h-4 w-4 shrink-0 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                <p className="text-sm text-slate-700">
                  Forecast:{' '}
                  <span className="font-semibold text-slate-900">
                    {categoryForecast.topCategory?.categoryName ?? 'No data'}
                  </span>
                  {categoryForecast.topCategory ? (
                    <span className="ml-1 text-xs text-slate-400">
                      category will have higher demand in the next {forecastSeries.steps}{' '}
                      {trendSeries.granularity === 'day' ? 'days' : 'periods'}.
                    </span>
                  ) : null}
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* ── Footer ── */}
        <div className="flex items-center gap-2 rounded-xl border border-blue-100 bg-blue-50 px-4 py-2.5 text-xs text-blue-700">
          <svg className="h-4 w-4 shrink-0 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <circle cx="12" cy="12" r="10" /><path strokeLinecap="round" d="M12 8v4m0 4h.01" />
          </svg>
          All data is based on the selected date range and filters.
        </div>

      </div>

      {/* ── Modal ── */}
      {modalConfig ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="flex max-h-[85vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-200 p-4">
              <h2 className="text-base font-semibold text-slate-900">{modalConfig.title}</h2>
              <button
                type="button"
                onClick={() => setOpenModal(null)}
                className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
              >
                Close
              </button>
            </div>
            <div className="overflow-y-auto p-4">
              <AnalyticsTable columns={modalConfig.columns} rows={modalConfig.rows} />
            </div>
          </div>
        </div>
      ) : null}
    </main>
  )
}
