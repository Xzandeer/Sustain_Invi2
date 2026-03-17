'use client'

import { useEffect, useMemo, useState } from 'react'
import { collection, onSnapshot } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import ProtectedRoute from '@/components/ProtectedRoute'
import SalesFilters from '@/components/SalesFilters'
import SalesTable from '@/components/SalesTable'
import SalesViewModal from '@/components/SalesViewModal'
import InventorySearchSelect from '@/components/InventorySearchSelect'

interface SaleTransaction {
  docId: string
  id: string
  customer: string
  items: Array<{
    name: string
    quantity: number
    price: number
    categoryId: string
    status: string
  }>
  totalAmount: number
  status: 'completed' | 'voided'
  createdAt: Date | null
}

interface InventoryItem {
  id: string
  name: string
  category: string
  price: number
  quantity: number
  isDeleted?: boolean
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
  if (typeof value === 'number' || typeof value === 'string') {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? null : date
  }

  if (typeof value === 'object') {
    const timestamp = value as { toDate?: () => Date; seconds?: number; nanoseconds?: number }
    if (typeof timestamp.toDate === 'function') {
      const date = timestamp.toDate()
      return Number.isNaN(date.getTime()) ? null : date
    }
    if (typeof timestamp.seconds === 'number') {
      const millis = timestamp.seconds * 1000 + Math.floor((timestamp.nanoseconds ?? 0) / 1_000_000)
      const date = new Date(millis)
      return Number.isNaN(date.getTime()) ? null : date
    }
  }
  return null
}

export default function SalesPage() {
  return (
    <ProtectedRoute>
      <SalesContent />
    </ProtectedRoute>
  )
}

function SalesContent() {
  const [transactions, setTransactions] = useState<SaleTransaction[]>([])
  const [inventoryItems, setInventoryItems] = useState<InventoryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState('')

  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'completed' | 'voided'>('all')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [selectedItemId, setSelectedItemId] = useState('')
  const [saleQuantity, setSaleQuantity] = useState('')
  const [customer, setCustomer] = useState('')

  const [selectedTransaction, setSelectedTransaction] = useState<SaleTransaction | null>(null)

  useEffect(() => {
    const unsubscribeSales = onSnapshot(
      collection(db, 'sales'),
      (snapshot) => {
        const list: SaleTransaction[] = snapshot.docs.map((saleDoc) => {
          const data = saleDoc.data() as Record<string, unknown>
          const parsedStatus = typeof data.status === 'string' ? data.status.toLowerCase() : 'completed'
          const items = Array.isArray(data.items)
            ? data.items
                .map((item) => {
                  const saleItem = item as Record<string, unknown>
                  const name = typeof saleItem.name === 'string' ? saleItem.name.trim() : ''
                  if (!name) return null
                  return {
                    name,
                    quantity: toNumber(saleItem.quantity, 0),
                    price: toNumber(saleItem.price, 0),
                    categoryId: typeof saleItem.categoryId === 'string' ? saleItem.categoryId : '',
                    status: typeof saleItem.status === 'string' ? saleItem.status : 'completed',
                  }
                })
                .filter(
                  (
                    item
                  ): item is {
                    name: string
                    quantity: number
                    price: number
                    categoryId: string
                    status: string
                  } => item !== null
                )
            : []

          return {
            docId: saleDoc.id,
            id: typeof data.id === 'string' && data.id.trim() ? data.id : saleDoc.id,
            customer: typeof data.customer === 'string' && data.customer.trim() ? data.customer : 'Walk-in Customer',
            items,
            totalAmount: toNumber(data.totalAmount, toNumber(data.total, toNumber(data.amount))),
            status: parsedStatus === 'voided' ? 'voided' : 'completed',
            createdAt: toDate(data.date ?? data.saleDate ?? data.createdAt ?? data.timestamp),
          }
        })

        list.sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0))
        setTransactions(list)
        setLoading(false)
      },
      (error) => {
        console.error('Error loading sales:', error)
        setLoading(false)
      }
    )

    const unsubscribeInventory = onSnapshot(
      collection(db, 'inventory'),
      (snapshot) => {
        const list: InventoryItem[] = snapshot.docs
          .map((itemDoc) => {
            const data = itemDoc.data() as Record<string, unknown>
            const quantity = Math.max(0, toNumber(data.stock ?? data.quantity, 0))
            return {
              id: itemDoc.id,
              name: typeof data.name === 'string' ? data.name.trim() : '',
              category:
                (typeof data.categoryName === 'string' && data.categoryName.trim()) ||
                (typeof data.category === 'string' && data.category.trim()) ||
                'Uncategorized',
              price: Math.max(0, toNumber(data.price, 0)),
              quantity,
              isDeleted: data.isDeleted === true,
            }
          })
          .filter((item) => item.name && item.isDeleted !== true)

        list.sort((a, b) => a.name.localeCompare(b.name))
        setInventoryItems(list)
      },
      (error) => console.error('Error loading inventory for sales:', error)
    )

    return () => {
      unsubscribeSales()
      unsubscribeInventory()
    }
  }, [])

  const selectedItem = useMemo(
    () => inventoryItems.find((item) => item.id === selectedItemId) ?? null,
    [inventoryItems, selectedItemId]
  )

  const computedTotal = useMemo(() => {
    const qty = Number(saleQuantity)
    if (!selectedItem || !Number.isFinite(qty) || qty <= 0) return 0
    return qty * selectedItem.price
  }, [saleQuantity, selectedItem])

  const filteredTransactions = useMemo(() => {
    const searchTerm = search.trim().toLowerCase()
    const startTime = startDate ? new Date(startDate).getTime() : null
    const endTime = endDate ? new Date(new Date(endDate).setHours(23, 59, 59, 999)).getTime() : null

        return transactions.filter((transaction) => {
      const matchesSearch =
        !searchTerm ||
        transaction.customer.toLowerCase().includes(searchTerm) ||
        transaction.id.toLowerCase().includes(searchTerm) ||
        transaction.items.some((item) => item.name.toLowerCase().includes(searchTerm))

      const matchesStatus = statusFilter === 'all' ? true : transaction.status === statusFilter

      const transactionTime = transaction.createdAt?.getTime()
      const matchesDate =
        transactionTime == null
          ? !startTime && !endTime
          : (startTime == null || transactionTime >= startTime) && (endTime == null || transactionTime <= endTime)

      return matchesSearch && matchesStatus && matchesDate
    })
  }, [transactions, search, statusFilter, startDate, endDate])

  const submitSale = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setFormError('')

    const quantity = Math.floor(Number(saleQuantity))
    if (!selectedItemId || !Number.isFinite(quantity) || quantity <= 0) {
      setFormError('Select an item and enter a valid quantity.')
      return
    }

    if (selectedItem && quantity > selectedItem.quantity) {
      setFormError('Cannot sell more than available stock')
      return
    }

    setSubmitting(true)
    try {
      const response = await fetch('/api/sales', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          itemId: selectedItemId,
          quantity,
          customer: customer.trim() || 'Walk-in Customer',
        }),
      })

      const result = (await response.json()) as { error?: string }
      if (!response.ok) {
        throw new Error(result.error || 'Failed to create sale.')
      }

      setSaleQuantity('')
      setCustomer('')
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Failed to create sale.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="min-h-[calc(100vh-64px)] bg-slate-100 px-4 py-8 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-[1700px] space-y-6">
        <header>
          <h1 className="text-4xl font-bold text-slate-900">Sales</h1>
          <p className="mt-1 text-lg text-slate-600">Create sales and review transaction history.</p>
        </header>

        <section className="rounded-xl border bg-white p-6 shadow-sm">
          <h2 className="mb-4 text-xl font-semibold text-slate-900">Record Sale</h2>
          <form onSubmit={submitSale} className="grid gap-4 lg:grid-cols-4">
            <div className="lg:col-span-2">
              <label className="mb-1 block text-sm font-medium text-slate-700">Inventory Item</label>
              <InventorySearchSelect
                items={inventoryItems}
                value={selectedItemId}
                onValueChange={setSelectedItemId}
                placeholder="Search item"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700">Quantity</label>
              <input
                type="number"
                min={1}
                value={saleQuantity}
                onChange={(event) => setSaleQuantity(event.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-slate-500"
                required
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700">Customer (Optional)</label>
              <input
                type="text"
                value={customer}
                onChange={(event) => setCustomer(event.target.value)}
                placeholder="Walk-in customer"
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-slate-500"
              />
            </div>
            <div className="lg:col-span-4 flex flex-wrap items-center gap-3">
              {selectedItem && (
                <div className="w-full rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
                  <p><span className="font-semibold text-slate-900">Item:</span> {selectedItem.name}</p>
                  <p><span className="font-semibold text-slate-900">Category:</span> {selectedItem.category}</p>
                  <p><span className="font-semibold text-slate-900">Price:</span> PHP {selectedItem.price.toFixed(2)}</p>
                  <p><span className="font-semibold text-slate-900">Stock Available:</span> {selectedItem.quantity}</p>
                </div>
              )}
              <p className="text-sm font-medium text-slate-700">
                Total: <span className="text-slate-900">PHP {computedTotal.toFixed(2)}</span>
              </p>
              <button
                type="submit"
                disabled={submitting}
                className="rounded-lg bg-sky-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-sky-800 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting ? 'Saving...' : 'Create Sale'}
              </button>
            </div>
            {formError && <p className="text-sm text-red-600 lg:col-span-4">{formError}</p>}
          </form>
        </section>

        <section className="rounded-xl border bg-white p-6 shadow-sm">
          <SalesFilters
            search={search}
            onSearchChange={setSearch}
            statusFilter={statusFilter}
            onStatusFilterChange={setStatusFilter}
            startDate={startDate}
            onStartDateChange={setStartDate}
            endDate={endDate}
            onEndDateChange={setEndDate}
          />
        </section>

        <section className="rounded-xl border bg-white p-6 shadow-sm">
          <SalesTable
            transactions={filteredTransactions}
            loading={loading}
            onView={setSelectedTransaction}
            onVoid={() => Promise.resolve()}
            voidingId={null}
          />
        </section>
      </div>

      <SalesViewModal transaction={selectedTransaction} onClose={() => setSelectedTransaction(null)} />
    </main>
  )
}
