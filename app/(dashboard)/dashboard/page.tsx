'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { collection, onSnapshot } from 'firebase/firestore'
import { BarChart3, Boxes, PlusCircle } from 'lucide-react'
import { db } from '@/lib/firebase'
import ProtectedRoute from '@/components/ProtectedRoute'
import DashboardStats from '@/components/DashboardStats'
import AlertsWarnings from '@/components/AlertsWarnings'
import type { LowStockItem } from '@/lib/server/salesInventoryMetrics'

interface SaleDoc {
  id: string
  items?: Array<{
    quantity?: number | string
    price?: number | string
    categoryId?: string
    status?: string
  }>
  totalAmount?: number
  total?: number
  amount?: number
  quantity?: number
  createdAt?: unknown
}

interface InventoryDoc {
  id: string
  name?: string
  quantity?: number
  minStock?: number
  category?: string
  categoryName?: string
  isDeleted?: boolean
}

const formatCurrency = (value: number) =>
  `PHP ${value.toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`

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
  if (typeof value === 'object') {
    const timestamp = value as { toDate?: () => Date; seconds?: number; nanoseconds?: number }
    if (typeof timestamp.toDate === 'function') {
      const parsed = timestamp.toDate()
      return Number.isNaN(parsed.getTime()) ? null : parsed
    }
    if (typeof timestamp.seconds === 'number') {
      const parsed = new Date(timestamp.seconds * 1000 + Math.floor((timestamp.nanoseconds ?? 0) / 1_000_000))
      return Number.isNaN(parsed.getTime()) ? null : parsed
    }
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? null : parsed
  }
  return null
}

export default function DashboardPage() {
  return (
    <ProtectedRoute>
      <DashboardContent />
    </ProtectedRoute>
  )
}

function DashboardContent() {
  const [sales, setSales] = useState<SaleDoc[]>([])
  const [inventory, setInventory] = useState<InventoryDoc[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const unsubscribeInventory = onSnapshot(collection(db, 'inventory'), (snapshot) => {
      const list = snapshot.docs
        .map((docSnapshot) => ({
          id: docSnapshot.id,
          ...docSnapshot.data(),
          quantity: toNumber(docSnapshot.data().stock ?? docSnapshot.data().quantity, 0),
          isDeleted: docSnapshot.data().isDeleted === true,
        }))
        .filter((item) => item.isDeleted !== true) as InventoryDoc[]
      setInventory(list)
      setLoading(false)
    })

    const unsubscribeSales = onSnapshot(collection(db, 'sales'), (snapshot) => {
      const list = snapshot.docs.map((docSnapshot) => {
        const data = docSnapshot.data() as Record<string, unknown>
        return {
          id: docSnapshot.id,
          items: Array.isArray(data.items) ? data.items : [],
          totalAmount: toNumber(data.totalAmount, toNumber(data.total, toNumber(data.amount, 0))),
          total: toNumber(data.total, 0),
          amount: toNumber(data.amount, 0),
          quantity: toNumber(data.quantity, 0),
          createdAt: toDate(data.createdAt),
        }
      }) as SaleDoc[]
      setSales(list)
    })

    return () => {
      unsubscribeInventory()
      unsubscribeSales()
    }
  }, [])

  const totalSales = useMemo(
    () => sales.reduce((sum, sale) => sum + toNumber(sale.totalAmount, toNumber(sale.total, toNumber(sale.amount))), 0),
    [sales]
  )

  const itemsSold = useMemo(
    () =>
      sales.reduce((sum, sale) => {
        const itemCount = Array.isArray(sale.items)
          ? sale.items.reduce((itemSum, item) => itemSum + Math.max(0, toNumber(item.quantity, 0)), 0)
          : Math.max(0, toNumber(sale.quantity, 0))
        return sum + itemCount
      }, 0),
    [sales]
  )

  const productsInStock = useMemo(
    () => inventory.reduce((sum, item) => sum + Math.max(0, toNumber(item.quantity, 0)), 0),
    [inventory]
  )

  const lowStockItems = useMemo<LowStockItem[]>(() => {
    return inventory
      .filter((item) => {
        const quantity = toNumber(item.quantity, 0)
        const minStock = toNumber(item.minStock, 0)
        return quantity <= minStock
      })
      .map((item) => ({
        id: item.id,
        name: item.name?.trim() || item.id,
        categoryName: item.categoryName?.trim() || item.category?.trim() || 'Uncategorized',
        stock: toNumber(item.quantity, 0),
      }))
  }, [inventory])

  const outOfStockItems = useMemo(
    () => inventory.filter((item) => toNumber(item.quantity, 0) === 0),
    [inventory]
  )

  return (
    <main className="flex-1 bg-slate-100 px-8 py-8">
      <div className="w-full space-y-6 p-6">
        <header>
          <h1 className="text-2xl font-bold text-slate-900">Dashboard</h1>
          <p className="text-sm text-gray-500">Summary of key sales and inventory metrics.</p>
        </header>

        <DashboardStats
          loading={loading}
          totalSales={formatCurrency(totalSales)}
          itemsSold={itemsSold}
          productsInStock={productsInStock}
          lowStockItems={lowStockItems.length}
          outOfStockItems={outOfStockItems.length}
        />
        <AlertsWarnings
          loading={loading}
          lowStockItems={lowStockItems}
          outOfStockCount={outOfStockItems.length}
        />

        <div className="flex flex-wrap gap-3">
          <Link
            href="/analytics"
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-500"
          >
            <BarChart3 className="h-4 w-4" />
            View Analytics
          </Link>
          <Link
            href="/sales"
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-900 transition hover:bg-slate-50"
          >
            <PlusCircle className="h-4 w-4" />
            Add Sale
          </Link>
          <Link
            href="/inventory"
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-900 transition hover:bg-slate-50"
          >
            <Boxes className="h-4 w-4" />
            View Inventory
          </Link>
        </div>
      </div>
    </main>
  )
}
