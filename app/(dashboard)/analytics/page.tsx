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
import AnalyticsTable from '@/components/analytics/AnalyticsTable'
import AnalyticsBadge from '@/components/analytics/AnalyticsBadge'
import type { InventoryRecord } from '@/lib/server/salesInventoryMetrics'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend)

interface SaleRecord {
  id: string
  items: Array<{
    name: string
    quantity: number
    price: number
    categoryId: string
    status: 'New' | 'Refurbished'
  }>
  totalAmount: number
  createdAt: Date | null
}

type SaleItemCondition = 'New' | 'Refurbished'
type AnalyticsModalType = 'top' | 'low' | 'stock' | null

interface InventoryStats {
  totalProducts: number
  lowStockItems: number
  outOfStockItems: number
}

const CATEGORY_THRESHOLDS: Record<string, number> = {
  Kitchenware: 75,
  Tools: 50,
  Bags: 40,
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

const isSameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate()

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
  const today = useMemo(() => {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return d
  }, [])
  const lastWeek = useMemo(() => {
    const d = new Date()
    d.setDate(d.getDate() - 7)
    d.setHours(0, 0, 0, 0)
    return d
  }, [])
  const [startDate, setStartDate] = useState<string>(lastWeek.toISOString().split('T')[0] ?? '')
  const [endDate, setEndDate] = useState<string>(today.toISOString().split('T')[0] ?? '')
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
                  const name = typeof saleItem.name === 'string' && saleItem.name.trim() ? saleItem.name : 'Unnamed Item'
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
                .filter((item) => item.quantity > 0 || item.name === 'Unnamed Item' || item.price >= 0)
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

  const totalSalesAmount = useMemo(
    () => sales.reduce((sum, sale) => sum + Number(sale.totalAmount ?? 0), 0),
    [sales]
  )

  const itemsSold = useMemo(
    () =>
      sales.reduce(
        (sum, sale) =>
          sum +
          sale.items.reduce((itemSum, item) => itemSum + Number(item.quantity ?? 0), 0),
        0
      ),
    [sales]
  )

  const salesByCategory = useMemo(() => {
    const salesCategoryMap = new Map<
      string,
      { categoryId: string; categoryName: string; itemsSold: number; revenue: number; todaySales: number }
    >()
    const now = new Date()
    sales.forEach((sale) => {
      const saleDate = toDate(sale.createdAt)
      sale.items.forEach((item) => {
        if (selectedCondition !== 'All Conditions' && item.status !== selectedCondition) return
        const key = item.categoryId || 'General'
        const current = salesCategoryMap.get(key) ?? {
          categoryId: key,
          categoryName: categoryNameMap[key] ?? key ?? 'General',
          itemsSold: 0,
          revenue: 0,
          todaySales: 0,
        }
        const itemRevenue = Number(item.quantity ?? 0) * Number(item.price ?? 0)
        current.itemsSold += Number(item.quantity ?? 0)
        current.revenue += itemRevenue
        if (saleDate && isSameDay(saleDate, now)) {
          current.todaySales += itemRevenue
        }
        salesCategoryMap.set(key, current)
      })
    })
    return Array.from(salesCategoryMap.values())
  }, [sales, selectedCondition, categoryNameMap])

  const topSellingCategories = useMemo(
    () =>
      [...salesByCategory]
        .sort((a, b) => b.itemsSold - a.itemsSold)
        .map((row) => ({
          categoryId: row.categoryId,
          categoryName: row.categoryName,
          totalSales: Number(row.itemsSold ?? 0),
          totalRevenue: Number(row.revenue ?? 0),
          todaysSales: Number(row.todaySales ?? 0),
        })),
    [salesByCategory]
  )

  const lowPerformingCategories = useMemo(
    () =>
      [...salesByCategory]
        .sort((a, b) => a.itemsSold - b.itemsSold)
        .map((row) => ({
          categoryId: row.categoryId,
          categoryName: row.categoryName,
          totalSales: Number(row.itemsSold ?? 0),
          totalRevenue: Number(row.revenue ?? 0),
          todaysSales: Number(row.todaySales ?? 0),
        })),
    [salesByCategory]
  )

  const lowStockCategories = useMemo(() => {
    const stockByCategory = new Map<string, number>()
    inventory.forEach((item) => {
      const categoryName = item.categoryName ?? item.category ?? 'General'
      stockByCategory.set(
        categoryName,
        Number(stockByCategory.get(categoryName) ?? 0) + Number(item.quantity ?? 0)
      )
    })

    return Array.from(stockByCategory.entries()).map(([category, stock]) => {
      const threshold = CATEGORY_THRESHOLDS[category] ?? 50
      return {
        category,
        stock: Number(stock ?? 0),
        threshold: Number(threshold ?? 0),
        status: stock < threshold ? ('Low' as const) : ('OK' as const),
      }
    })
  }, [inventory])

  const insights = useMemo(() => {
    const lines: string[] = []

    const topRevenue = [...salesByCategory].sort((a, b) => b.revenue - a.revenue)[0]
    if (topRevenue) {
      lines.push(`${topRevenue.categoryName} is the top performing category. Consider increasing inventory.`)
    }

    const lowestUnits = [...salesByCategory].sort((a, b) => a.itemsSold - b.itemsSold)[0]
    if (lowestUnits && lowestUnits.itemsSold > 0) {
      lines.push(`${lowestUnits.categoryName} has low sales. Consider promotions or discounts.`)
    }

    const lowStock = lowStockCategories.find((category) => category.status === 'Low')
    if (lowStock) {
      lines.push(`${lowStock.category} inventory is running low. Increase item quantities soon.`)
    }

    if (lines.length === 0) {
      lines.push('Sales and inventory are stable. Continue monitoring category performance weekly.')
    }

    return lines
  }, [salesByCategory, lowStockCategories])

  const [showExtendedInsights, setShowExtendedInsights] = useState(false)

  const visibleInsights = useMemo(
    () => insights.slice(0, 2),
    [insights]
  )

  // Auto-adjust date range if no data in default range
  useEffect(() => {
    if (!sales.length) return
    const startDateObj = new Date(startDate)
    const endDateObj = new Date(endDate)
    const filteredSales = sales.filter((sale) => {
      const saleDate = toDate(sale.createdAt)
      return saleDate && saleDate >= startDateObj && saleDate <= endDateObj
    })
    if (filteredSales.length === 0) {
      const validDates = sales
        .map((sale) => toDate(sale.createdAt))
        .filter((d): d is Date => !!d)
      if (validDates.length) {
        const minDate = new Date(Math.min(...validDates.map((d) => Number(d.getTime()))))
        const maxDate = new Date(Math.max(...validDates.map((d) => Number(d.getTime()))))
        setStartDate(minDate.toISOString().split('T')[0] ?? '')
        setEndDate(maxDate.toISOString().split('T')[0] ?? '')
      }
    }
  }, [sales, startDate, endDate])

  const salesTrendByCategory = useMemo(() => {
    const startDateObj = new Date(startDate)
    const endDateObj = new Date(endDate)
    const map = new Map<string, number>()
    sales.forEach((sale) => {
      const date = toDate(sale.createdAt)
      if (!date) return
      const dateInRange = date >= startDateObj && date <= endDateObj
      if (!dateInRange) return
      const matchingItems = sale.items.filter((item) => {
        const categoryMatch = selectedCategory === 'All Categories' || item.categoryId === selectedCategory
        const conditionMatch = selectedCondition === 'All Conditions' || item.status === selectedCondition
        return categoryMatch && conditionMatch
      })
      if (matchingItems.length === 0) return
      const dateStr = date.toISOString().slice(0, 10)
      const totalForDate = matchingItems.reduce(
        (sum, item) => sum + Number(item.quantity ?? 0) * Number(item.price ?? 0),
        0
      )
      map.set(dateStr, Number(map.get(dateStr) ?? 0) + totalForDate)
    })
    const allDates = Array.from(map.keys()).sort()
    const categoriesSet = new Set<string>()
    sales.forEach((sale) => {
      sale.items.forEach((item) => {
        if (item.categoryId) {
          categoriesSet.add(item.categoryId)
        }
      })
    })
    const allCategories = Array.from(categoriesSet).sort((a, b) =>
      (categoryNameMap[a] ?? a).localeCompare(categoryNameMap[b] ?? b)
    )
    const datasets = [{
      label:
        selectedCategory === 'All Categories'
          ? 'Total Sales'
          : `${categoryNameMap[selectedCategory] ?? selectedCategory} Sales`,
      data: allDates.map((date) => Number(map.get(date) ?? 0)),
      fill: false,
      borderColor: '#0f4c81',
      backgroundColor: '#0f4c81',
      borderWidth: 2,
      pointRadius: 3,
      tension: 0.3,
    }]
    return {
      labels: allDates,
      datasets,
      allCategories,
    }
  }, [sales, startDate, endDate, selectedCategory, selectedCondition, categoryNameMap])

  const topSellingCategoryRows = useMemo(
    () =>
      topSellingCategories.slice(0, 4).map((row) => ({
        key: row.categoryId,
        cells: [
          <span key={`${row.categoryId}-name`} className="font-medium text-slate-900">{row.categoryName}</span>,
          <span key={`${row.categoryId}-sales`} className="block text-right">{row.totalSales}</span>,
          <span key={`${row.categoryId}-revenue`} className="block text-right">{currency(row.totalRevenue)}</span>,
          <span key={`${row.categoryId}-today`} className="block text-right">{currency(row.todaysSales)}</span>,
        ],
      })),
    [topSellingCategories]
  )

  const allTopSellingCategoryRows = useMemo(
    () =>
      topSellingCategories.map((row) => ({
        key: row.categoryId,
        cells: [
          <span key={`${row.categoryId}-name`} className="font-medium text-slate-900">{row.categoryName}</span>,
          <span key={`${row.categoryId}-sales`} className="block text-right">{row.totalSales}</span>,
          <span key={`${row.categoryId}-revenue`} className="block text-right">{currency(row.totalRevenue)}</span>,
          <span key={`${row.categoryId}-today`} className="block text-right">{currency(row.todaysSales)}</span>,
        ],
      })),
    [topSellingCategories]
  )

  const lowPerformingCategoryRows = useMemo(
    () =>
      lowPerformingCategories.slice(0, 4).map((row) => ({
        key: row.categoryId,
        cells: [
          <span key={`${row.categoryId}-name`} className="font-medium text-slate-900">{row.categoryName}</span>,
          <span key={`${row.categoryId}-sales`} className="block text-right">{row.totalSales}</span>,
          <span key={`${row.categoryId}-revenue`} className="block text-right">{currency(row.totalRevenue)}</span>,
          <span key={`${row.categoryId}-today`} className="block text-right">{currency(row.todaysSales)}</span>,
        ],
      })),
    [lowPerformingCategories]
  )

  const allLowPerformingCategoryRows = useMemo(
    () =>
      lowPerformingCategories.map((row) => ({
        key: row.categoryId,
        cells: [
          <span key={`${row.categoryId}-name`} className="font-medium text-slate-900">{row.categoryName}</span>,
          <span key={`${row.categoryId}-sales`} className="block text-right">{row.totalSales}</span>,
          <span key={`${row.categoryId}-revenue`} className="block text-right">{currency(row.totalRevenue)}</span>,
          <span key={`${row.categoryId}-today`} className="block text-right">{currency(row.todaysSales)}</span>,
        ],
      })),
    [lowPerformingCategories]
  )

  const lowStockRows = useMemo(
    () =>
      lowStockCategories.slice(0, 4).map((row) => ({
        key: row.category,
        cells: [
          <span key={`${row.category}-name`} className="font-medium text-slate-900">{row.category}</span>,
          <span key={`${row.category}-stock`} className="block text-right">{row.stock}</span>,
          <span key={`${row.category}-threshold`} className="block text-right">{row.threshold}</span>,
          <AnalyticsBadge key={`${row.category}-status`} variant={row.status === 'Low' ? 'low' : 'ok'}>
            {row.status}
          </AnalyticsBadge>,
        ],
      })),
    [lowStockCategories]
  )

  const allLowStockRows = useMemo(
    () =>
      lowStockCategories.map((row) => ({
        key: row.category,
        cells: [
          <span key={`${row.category}-name`} className="font-medium text-slate-900">{row.category}</span>,
          <span key={`${row.category}-stock`} className="block text-right">{row.stock}</span>,
          <span key={`${row.category}-threshold`} className="block text-right">{row.threshold}</span>,
          <AnalyticsBadge key={`${row.category}-status`} variant={row.status === 'Low' ? 'low' : 'ok'}>
            {row.status}
          </AnalyticsBadge>,
        ],
      })),
    [lowStockCategories]
  )

  const modalConfig = useMemo(() => {
    if (openModal === 'top') {
      return {
        title: 'Top-Selling Categories',
        columns: [
          { header: 'Category' },
          { header: 'Total Sales (Units)', className: 'text-right' },
          { header: 'Total Revenue', className: 'text-right' },
          { header: "Today's Sales", className: 'text-right' },
        ],
        rows: allTopSellingCategoryRows,
      }
    }

    if (openModal === 'low') {
      return {
        title: 'Low-Performing Categories',
        columns: [
          { header: 'Category' },
          { header: 'Total Sales', className: 'text-right' },
          { header: 'Total Revenue', className: 'text-right' },
          { header: "Today's Sales", className: 'text-right' },
        ],
        rows: allLowPerformingCategoryRows,
      }
    }

    if (openModal === 'stock') {
      return {
        title: 'Low Stock Categories',
        columns: [
          { header: 'Category' },
          { header: 'Total Current Stock', className: 'text-right' },
          { header: 'Threshold', className: 'text-right' },
          { header: 'Status' },
        ],
        rows: allLowStockRows,
      }
    }

    return null
  }, [allLowPerformingCategoryRows, allLowStockRows, allTopSellingCategoryRows, openModal])

  return (
    <main className="min-h-[calc(100vh-64px)] bg-slate-100 p-6">
      <div className="mx-auto max-w-[1700px] space-y-6">
        <header>
          <h1 className="text-2xl font-bold text-slate-900">Analytics</h1>
          <p className="mt-1 text-sm text-gray-500">Category-based sales and inventory analysis.</p>
        </header>

        <AnalyticsCard title="Filters" className="rounded-2xl">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
            <div>
              <label className="mb-2 block text-sm font-medium text-slate-700">Start Date</label>
              <input
                type="date"
                value={startDate ?? ''}
                onChange={(e) => {
                  setStartDate(e.target.value ?? '')
                }}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-2 block text-sm font-medium text-slate-700">End Date</label>
              <input
                type="date"
                value={endDate ?? ''}
                onChange={(e) => {
                  setEndDate(e.target.value ?? '')
                }}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-2 block text-sm font-medium text-slate-700">Category</label>
              <select
                value={selectedCategory}
                onChange={(e) => setSelectedCategory(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              >
                <option value="All Categories">All Categories</option>
                {salesTrendByCategory.allCategories.map((cat) => (
                  <option key={cat} value={cat}>{categoryNameMap[cat] ?? cat}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-2 block text-sm font-medium text-slate-700">Condition</label>
              <select
                value={selectedCondition}
                onChange={(e) =>
                  setSelectedCondition(
                    e.target.value === 'Refurbished'
                      ? 'Refurbished'
                      : e.target.value === 'New'
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
          </div>
        </AnalyticsCard>

        <AnalyticsCard
          title="Sales Trend"
          subtitle={
            selectedCategory === 'All Categories'
              ? 'All categories combined'
              : `${categoryNameMap[selectedCategory] ?? selectedCategory} only`
          }
          actions={
            <div className="text-right">
              <p className="text-sm font-medium text-slate-900">{currency(totalSalesAmount)}</p>
              <p className="text-sm text-gray-500">{itemsSold} items sold</p>
            </div>
          }
        >
          <div className="h-64">
            <Line
              data={{
                labels: salesTrendByCategory.labels,
                datasets: salesTrendByCategory.datasets,
              }}
              options={{
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
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
        </AnalyticsCard>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <AnalyticsCard
            title="Top-Selling Categories"
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
                { header: 'Category' },
                { header: 'Total Sales (Units)', className: 'text-right' },
                { header: 'Total Revenue', className: 'text-right' },
                { header: "Today's Sales", className: 'text-right' },
              ]}
              rows={topSellingCategoryRows}
            />
          </AnalyticsCard>

          <AnalyticsCard
            title="Low-Performing Categories"
            actions={
              <button
                type="button"
                onClick={() => setOpenModal('low')}
                className="text-sm font-medium text-blue-600 transition hover:text-blue-500"
              >
                View All
              </button>
            }
          >
            <AnalyticsTable
              columns={[
                { header: 'Category' },
                { header: 'Total Sales', className: 'text-right' },
                { header: 'Total Revenue', className: 'text-right' },
                { header: "Today's Sales", className: 'text-right' },
              ]}
              rows={lowPerformingCategoryRows}
            />
          </AnalyticsCard>
        </div>

        <AnalyticsCard
          title="Low Stock Categories"
          actions={
            <button
              type="button"
              onClick={() => setOpenModal('stock')}
              className="text-sm font-medium text-blue-600 transition hover:text-blue-500"
            >
              View All
            </button>
          }
        >
          <AnalyticsTable
            columns={[
              { header: 'Category' },
              { header: 'Total Current Stock', className: 'text-right' },
              { header: 'Threshold', className: 'text-right' },
              { header: 'Status', className: 'text-left' },
            ]}
            rows={lowStockRows}
          />
        </AnalyticsCard>

        <AnalyticsCard title="Insights & Recommendations">
          <div className="space-y-3">
            {visibleInsights.map((line, index) => (
              <p key={`${line}-${index}`} className="rounded-xl bg-gray-100 p-3 text-sm text-gray-600">
                {line}
              </p>
            ))}
          </div>
        </AnalyticsCard>
      </div>

      {modalConfig ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="flex max-h-[85vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-200 p-4">
              <h2 className="text-lg font-semibold text-slate-900">{modalConfig.title}</h2>
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
