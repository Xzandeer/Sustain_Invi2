'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Legend,
} from 'chart.js'
import { Line } from 'react-chartjs-2'
import { collection, onSnapshot } from 'firebase/firestore'
import ProtectedRoute from '@/components/ProtectedRoute'
import { db } from '@/lib/firebase'
import AnalyticsCard from '@/components/analytics/AnalyticsCard'
import AnalyticsBadge from '@/components/analytics/AnalyticsBadge'
import AnalyticsTable from '@/components/analytics/AnalyticsTable'
import type { InventoryRecord } from '@/lib/server/salesInventoryMetrics'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend)

type SaleItemCondition = 'New' | 'Refurbished'
type AnalyticsModalType = 'top' | null
type TimeRangePreset = 'this-week' | 'this-month' | 'last-month' | 'last-6-months' | 'this-year' | 'custom'

interface SaleRecord {
  id: string
  items: Array<{
    name: string
    quantity: number
    price: number
    categoryId: string
    status: SaleItemCondition
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
                    status: (saleItem.status === 'Refurbished' ? 'Refurbished' : 'New') as SaleItemCondition,
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

    return () => {
      unsubscribeCategories()
      unsubscribeSales()
      unsubscribeInventory()
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
      const conditionMatch = selectedCondition === 'All Conditions' || item.status === selectedCondition
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

  return (
    <main className="min-h-[calc(100vh-64px)] bg-slate-100 px-2 py-2.5 sm:px-2.5">
      <div className="mx-auto max-w-[1620px] space-y-3.5">
        <header>
          <h1 className="text-[1.6rem] font-bold text-slate-900">Analytics</h1>
        </header>

        <AnalyticsCard title="Filters" className="rounded-2xl">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-5">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-700">Time Range</label>
              <select
                value={timeRangePreset}
                onChange={(event) => setTimeRangePreset(event.target.value as TimeRangePreset)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
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
              <label className="mb-1.5 block text-xs font-medium text-slate-700">Category</label>
              <select
                value={selectedCategory}
                onChange={(event) => setSelectedCategory(event.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              >
                <option value="All Categories">All Categories</option>
                {availableCategoryIds.map((categoryId) => (
                  <option key={categoryId} value={categoryId}>
                    {categoryNameMap[categoryId] ?? categoryId}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-700">Condition</label>
              <select
                value={selectedCondition}
                onChange={(event) =>
                  setSelectedCondition(
                    event.target.value === 'Refurbished'
                      ? 'Refurbished'
                      : event.target.value === 'New'
                        ? 'New'
                        : 'All Conditions'
                  )
                }
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              >
                <option value="All Conditions">All Conditions</option>
                <option value="New">New</option>
                <option value="Refurbished">Refurbished</option>
              </select>
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-700">Start Date</label>
              <input
                type="date"
                value={timeRangePreset === 'custom' ? customStartDate : formatDateInput(activeRange.start)}
                max={timeRangePreset === 'custom' && customEndDate ? customEndDate : undefined}
                onChange={(event) => handleCustomStartDateChange(event.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-700">End Date</label>
              <input
                type="date"
                value={timeRangePreset === 'custom' ? customEndDate : formatDateInput(activeRange.end)}
                min={timeRangePreset === 'custom' && customStartDate ? customStartDate : undefined}
                onChange={(event) => handleCustomEndDateChange(event.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
          </div>

          {timeRangePreset === 'custom' && dateRangeError ? (
            <p className="mt-3 text-sm text-red-500">{dateRangeError}</p>
          ) : null}
        </AnalyticsCard>

        <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
          <AnalyticsCard
            title="Total Sales"
            subtitle={getRangeLabel(timeRangePreset)}
            actions={<p className="text-lg font-semibold text-slate-900">{currency(currentSummary.totalSales)}</p>}
          >
            <div className="space-y-2.5">
              {comparisonMetrics.totalSales.map((metric) => (
                <div key={metric.label} className="flex items-center justify-between gap-2.5 rounded-xl bg-slate-50 px-3 py-2">
                  <div>
                    <p className="text-sm font-medium text-slate-900">{metric.label}</p>
                    <p className="text-xs text-slate-500">{currency(metric.value)}</p>
                  </div>
                  <AnalyticsBadge variant={getChangeVariant(metric.change)}>
                    {getComparisonText(metric.change)}
                  </AnalyticsBadge>
                </div>
              ))}
            </div>
          </AnalyticsCard>

          <AnalyticsCard
            title="Items Sold"
            subtitle={getRangeLabel(timeRangePreset)}
            actions={<p className="text-lg font-semibold text-slate-900">{compactNumber.format(currentSummary.itemsSold)}</p>}
          >
            <div className="space-y-2.5">
              {comparisonMetrics.itemsSold.map((metric) => (
                <div key={metric.label} className="flex items-center justify-between gap-2.5 rounded-xl bg-slate-50 px-3 py-2">
                  <div>
                    <p className="text-sm font-medium text-slate-900">{metric.label}</p>
                    <p className="text-xs text-slate-500">{compactNumber.format(metric.value)} items</p>
                  </div>
                  <AnalyticsBadge variant={getChangeVariant(metric.change)}>
                    {getComparisonText(metric.change)}
                  </AnalyticsBadge>
                </div>
              ))}
            </div>
          </AnalyticsCard>

          <AnalyticsCard
            title="Top Category"
            subtitle={getRangeLabel(timeRangePreset)}
            actions={
              <div className="text-right">
                <p className="text-lg font-semibold text-slate-900">
                  {currentSummary.topCategory?.categoryName ?? 'No sales'}
                </p>
                <p className="text-xs text-slate-500">
                  {currentSummary.topCategory ? currency(currentSummary.topCategory.revenue) : 'No revenue'}
                </p>
              </div>
            }
          >
            <div className="space-y-2.5">
              {comparisonMetrics.topCategory.map((metric) => (
                <div key={metric.label} className="flex items-center justify-between gap-2.5 rounded-xl bg-slate-50 px-3 py-2">
                  <div>
                    <p className="text-sm font-medium text-slate-900">{metric.label}</p>
                    <p className="text-xs text-slate-500">{currency(metric.value)}</p>
                  </div>
                  <AnalyticsBadge variant={getChangeVariant(metric.change)}>
                    {getComparisonText(metric.change)}
                  </AnalyticsBadge>
                </div>
              ))}
            </div>
          </AnalyticsCard>
        </div>

        <AnalyticsCard
          title="Sales Trend"
          subtitle={`${trendSeries.granularity === 'day' ? 'Daily' : 'Monthly'} trend from ${formatMonthLabel(activeRange.start)} to ${formatMonthLabel(activeRange.end)}`}
          actions={
            <div className="text-right">
              <p className="text-sm font-medium text-slate-900">{getRangeLabel(timeRangePreset)}</p>
              <p className="text-sm text-gray-500">
                {selectedCategory === 'All Categories' ? 'All categories' : categoryNameMap[selectedCategory] ?? selectedCategory}
              </p>
            </div>
          }
        >
          <div className="h-68">
            <Line
              data={{
                labels: forecastSeries.labels,
                datasets: [
                  {
                    label: 'Actual Sales',
                    data: forecastSeries.actualValues,
                    fill: true,
                    borderColor: '#0f4c81',
                    backgroundColor: 'rgba(15, 76, 129, 0.12)',
                    borderWidth: 2,
                    pointRadius: trendSeries.hasSinglePoint ? 6 : 3,
                    pointHoverRadius: trendSeries.hasSinglePoint ? 7 : 5,
                    tension: 0.3,
                  },
                  {
                    label: 'Forecast',
                    data: forecastSeries.forecastValues,
                    borderColor: '#f59e0b',
                    backgroundColor: 'transparent',
                    borderWidth: 2,
                    borderDash: [6, 6],
                    pointRadius: 0,
                    pointHoverRadius: 4,
                    tension: 0.3,
                    spanGaps: true,
                  },
                ],
              }}
              options={{
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                  legend: { display: true, position: 'bottom' },
                  tooltip: {
                    callbacks: {
                      label: (context) => `${context.dataset.label}: ${currency(Number(context.parsed.y ?? 0))}`,
                    },
                  },
                },
                scales: {
                  x: { grid: { display: false } },
                  y: {
                    beginAtZero: true,
                    ticks: {
                      callback: (value) => `PHP ${Number(value).toLocaleString('en-PH')}`,
                    },
                  },
                },
              }}
            />
          </div>
          <p className="mt-3 text-xs text-slate-500">{forecastSeries.note}</p>
        </AnalyticsCard>

        <section className="space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">Predictive Analytics</h2>
              <p className="text-xs text-slate-500">Based on sales trends</p>
            </div>
            <AnalyticsBadge variant="neutral">{predictiveSummary.forecastWindow}</AnalyticsBadge>
          </div>

          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            <AnalyticsCard
              title="Predicted Fast-Moving Category"
              subtitle={predictiveSummary.forecastWindow}
              actions={
                <p className="text-lg font-semibold text-slate-900">
                  {predictiveSummary.projectedFastMovingCategory}
                </p>
              }
            >
              <div className="rounded-xl bg-slate-50 px-3 py-2.5">
                <p className="text-sm text-slate-700">
                  Projected revenue: <span className="font-semibold text-slate-900">{currency(predictiveSummary.projectedCategoryRevenue)}</span>
                </p>
                <p className="mt-1 text-sm text-slate-700">
                  Projected items sold: <span className="font-semibold text-slate-900">{compactNumber.format(Math.round(predictiveSummary.projectedCategoryItems))}</span>
                </p>
              </div>
            </AnalyticsCard>

            <AnalyticsCard
              title="Projected Demand"
              subtitle={trendSeries.granularity === 'day' ? '7-day forecast' : 'Next-period forecast'}
              actions={<p className="text-lg font-semibold text-slate-900">{currency(predictiveSummary.projectedSales)}</p>}
            >
              <div className="rounded-xl bg-slate-50 px-3 py-2.5">
                <p className="text-sm text-slate-700">
                  Forecast window: <span className="font-semibold text-slate-900">{forecastSeries.trailingWindow} {trendSeries.granularity === 'day' ? 'periods' : 'periods'}</span>
                </p>
                <p className="mt-1 text-sm text-slate-700">
                  Source: <span className="font-semibold text-slate-900">sales transactions</span>
                </p>
              </div>
            </AnalyticsCard>
          </div>
        </section>

        <AnalyticsCard
          title="Summary"
          className="border-blue-100/80 bg-white/70"
          contentClassName="pt-2"
        >
          <p className="text-sm leading-6 text-slate-700">{analyticsSummary}</p>
        </AnalyticsCard>

        <div className="grid grid-cols-1 gap-3.5 xl:grid-cols-[2fr_1fr]">
          <AnalyticsCard
            title="Top Categories"
            subtitle={`Ranked for ${getRangeLabel(timeRangePreset)}`}
            actions={
              <button
                type="button"
                onClick={() => setOpenModal('top')}
                className="text-sm font-medium text-blue-600 transition hover:text-blue-500"
              >
                View All
              </button>
            }
          >
            <AnalyticsTable
              columns={[
                { header: '#' },
                { header: 'Category' },
                { header: 'Items Sold', className: 'text-right' },
                { header: 'Sales', className: 'text-right' },
              ]}
              rows={topCategoryRows}
              emptyMessage="No category sales found for the selected period."
            />
          </AnalyticsCard>

          <AnalyticsCard title="Inventory by Category" subtitle="Current stock snapshot">
            <AnalyticsTable
              columns={[
                { header: 'Category' },
                { header: 'Stock', className: 'text-right' },
              ]}
              rows={stockRows}
              emptyMessage="No inventory categories found."
            />
          </AnalyticsCard>
        </div>
      </div>

      {modalConfig ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="flex max-h-[85vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-200 p-3.5">
              <h2 className="text-lg font-semibold text-slate-900">{modalConfig.title}</h2>
              <button
                type="button"
                onClick={() => setOpenModal(null)}
                className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
              >
                Close
              </button>
            </div>
            <div className="overflow-y-auto p-3.5">
              <AnalyticsTable columns={modalConfig.columns} rows={modalConfig.rows} />
            </div>
          </div>
        </div>
      ) : null}
    </main>
  )
}
