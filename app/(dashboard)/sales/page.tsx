'use client'

import { useEffect, useMemo, useState } from 'react'
import { Timestamp, collection, doc, onSnapshot, runTransaction } from 'firebase/firestore'
import { Minus, Plus, Search, ShoppingCart, Trash2 } from 'lucide-react'
import { db } from '@/lib/firebase'
import ProtectedRoute from '@/components/ProtectedRoute'
import SalesFilters from '@/components/SalesFilters'
import SalesTable from '@/components/SalesTable'
import SalesViewModal from '@/components/SalesViewModal'

interface SaleTransaction {
  docId: string
  id: string
  customer: string
  items: Array<{
    itemId?: string
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

interface ParsedSaleItem {
  itemId: string | undefined
  name: string
  quantity: number
  price: number
  categoryId: string
  status: string
}

interface InventoryItem {
  id: string
  name: string
  categoryId?: string
  categoryName: string
  price: number
  stock: number
  reservedStock: number
  availableStock: number
  isDeleted?: boolean
}

interface CartItem {
  id: string
  name: string
  price: number
  quantity: number
  availableStock: number
  categoryName: string
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

const currency = (value: number) =>
  value.toLocaleString('en-PH', {
    style: 'currency',
    currency: 'PHP',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })

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
  const [error, setError] = useState('')
  const [successMessage, setSuccessMessage] = useState('')

  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'completed' | 'voided'>('all')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [inventorySearch, setInventorySearch] = useState('')
  const [customer, setCustomer] = useState('')
  const [cart, setCart] = useState<CartItem[]>([])

  const [selectedTransaction, setSelectedTransaction] = useState<SaleTransaction | null>(null)

  useEffect(() => {
    const unsubscribeSales = onSnapshot(
      collection(db, 'sales'),
      (snapshot) => {
        const list: SaleTransaction[] = snapshot.docs.map((saleDoc) => {
          const data = saleDoc.data() as Record<string, unknown>
          const parsedStatus = typeof data.status === 'string' ? data.status.toLowerCase() : 'completed'
          const items: ParsedSaleItem[] = Array.isArray(data.items)
            ? data.items
                .map((item) => {
                  const saleItem = item as Record<string, unknown>
                  const name = typeof saleItem.name === 'string' ? saleItem.name.trim() : ''
                  if (!name) return null
                  return {
                    itemId: typeof saleItem.itemId === 'string' ? saleItem.itemId : undefined,
                    name,
                    quantity: toNumber(saleItem.quantity, 0),
                    price: toNumber(saleItem.price, 0),
                    categoryId: typeof saleItem.categoryId === 'string' ? saleItem.categoryId : '',
                    status: typeof saleItem.status === 'string' ? saleItem.status : 'completed',
                  }
                })
                .filter((item): item is ParsedSaleItem => item !== null)
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
      (snapshotError) => {
        console.error('Error loading sales:', snapshotError)
        setLoading(false)
      }
    )

    const unsubscribeInventory = onSnapshot(
      collection(db, 'inventory'),
      (snapshot) => {
        const list: InventoryItem[] = snapshot.docs
          .map((itemDoc) => {
            const data = itemDoc.data() as Record<string, unknown>
            return {
              id: itemDoc.id,
              name: typeof data.name === 'string' ? data.name.trim() : '',
              categoryName:
                (typeof data.categoryName === 'string' && data.categoryName.trim()) ||
                (typeof data.category === 'string' && data.category.trim()) ||
                'Uncategorized',
              price: Math.max(0, toNumber(data.price, 0)),
              stock: Math.max(0, toNumber(data.stock ?? data.quantity, 0)),
              reservedStock: Math.max(0, toNumber(data.reservedStock, 0)),
              availableStock: Math.max(
                0,
                Math.max(0, toNumber(data.stock ?? data.quantity, 0)) - Math.max(0, toNumber(data.reservedStock, 0))
              ),
              isDeleted: data.isDeleted === true,
            }
          })
          .filter((item) => item.name && item.isDeleted !== true)

        list.sort((a, b) => a.name.localeCompare(b.name))
        setInventoryItems(list)
      },
      (snapshotError) => console.error('Error loading inventory for sales:', snapshotError)
    )

    return () => {
      unsubscribeSales()
      unsubscribeInventory()
    }
  }, [])

  useEffect(() => {
    setCart((currentCart) =>
      currentCart
        .map((cartItem) => {
          const liveItem = inventoryItems.find((item) => item.id === cartItem.id)
          if (!liveItem) return null
          return {
            ...cartItem,
            availableStock: liveItem.availableStock,
            price: liveItem.price,
            categoryName: liveItem.categoryName,
            quantity: Math.min(cartItem.quantity, liveItem.availableStock),
          }
        })
        .filter((item): item is CartItem => item !== null && item.availableStock > 0 && item.quantity > 0)
    )
  }, [inventoryItems])

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

  const filteredInventoryItems = useMemo(() => {
    const query = inventorySearch.trim().toLowerCase()

    return inventoryItems.filter((item) => {
      if (!query) return true
      return item.name.toLowerCase().includes(query) || item.categoryName.toLowerCase().includes(query)
    })
  }, [inventoryItems, inventorySearch])

  const cartTotal = useMemo(
    () => cart.reduce((sum, item) => sum + item.price * item.quantity, 0),
    [cart]
  )

  const addToCart = (item: InventoryItem) => {
    setError('')
    setSuccessMessage('')

    if (item.availableStock <= 0) {
      setError(`${item.name} is out of available stock.`)
      return
    }

    setCart((currentCart) => {
      const existingItem = currentCart.find((cartItem) => cartItem.id === item.id)

      if (existingItem) {
        if (existingItem.quantity >= item.availableStock) {
          setError(`Cannot add more than available stock for ${item.name}.`)
          return currentCart
        }

        return currentCart.map((cartItem) =>
          cartItem.id === item.id
            ? { ...cartItem, quantity: cartItem.quantity + 1, availableStock: item.availableStock, price: item.price }
            : cartItem
        )
      }

      return [
        ...currentCart,
        {
          id: item.id,
          name: item.name,
          price: item.price,
          quantity: 1,
          availableStock: item.availableStock,
          categoryName: item.categoryName,
        },
      ]
    })
  }

  const updateCartQuantity = (itemId: string, nextQuantity: number) => {
    setError('')
    setSuccessMessage('')

    setCart((currentCart) => {
      return currentCart.flatMap((item) => {
        if (item.id !== itemId) return [item]
        if (nextQuantity <= 0) return []
        if (nextQuantity > item.availableStock) {
          setError(`Cannot exceed available stock for ${item.name}.`)
          return [item]
        }
        return [{ ...item, quantity: nextQuantity }]
      })
    })
  }

  const removeFromCart = (itemId: string) => {
    setError('')
    setSuccessMessage('')
    setCart((currentCart) => currentCart.filter((item) => item.id !== itemId))
  }

  const completeSale = async () => {
    if (cart.length === 0) {
      setError('Cart is empty.')
      return
    }

    setSubmitting(true)
    setError('')
    setSuccessMessage('')

    try {
      const invalidCartItem = cart.find(
        (item) =>
          !item.id ||
          !item.name ||
          !Number.isFinite(item.price) ||
          item.price < 0 ||
          !Number.isFinite(item.quantity) ||
          item.quantity <= 0 ||
          !Number.isFinite(item.availableStock) ||
          item.availableStock < 0
      )

      if (invalidCartItem) {
        throw new Error(`Invalid cart item: ${invalidCartItem.name || invalidCartItem.id || 'Unknown item'}`)
      }

      const stockExceededItem = cart.find((item) => item.quantity > item.availableStock)
      if (stockExceededItem) {
        throw new Error(`${stockExceededItem.name} exceeds available stock`)
      }

      console.log('CART:', cart)

      const response = await fetch('/api/sales', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: cart.map((item) => ({
            itemId: item.id,
            quantity: item.quantity,
          })),
          customer: customer.trim() || 'Walk-in Customer',
        }),
      })

      const result = (await response.json()) as { error?: string }
      if (!response.ok) {
        throw new Error(result.error || 'Failed to complete sale.')
      }

      setCart([])
      setCustomer('')
      setSuccessMessage('Sale completed successfully.')
    } catch (checkoutError) {
      console.error('SALE ERROR:', checkoutError)
      setError(checkoutError instanceof Error ? checkoutError.message : 'Failed to complete sale.')
    } finally {
      setSubmitting(false)
    }
  }

  const reserveOrder = async () => {
    if (cart.length === 0) {
      setError('Cart is empty.')
      return
    }

    setSubmitting(true)
    setError('')
    setSuccessMessage('')

    try {
      const invalidCartItem = cart.find(
        (item) =>
          !item.id ||
          !item.name ||
          !Number.isFinite(item.price) ||
          item.price < 0 ||
          !Number.isFinite(item.quantity) ||
          item.quantity <= 0
      )

      if (invalidCartItem) {
        throw new Error(`Invalid cart item: ${invalidCartItem.name || invalidCartItem.id || 'Unknown item'}`)
      }

      const reservationRef = doc(collection(db, 'reservations'))
      const createdAt = Timestamp.now()
      const expiresAt = Timestamp.fromDate(new Date(Date.now() + 3 * 24 * 60 * 60 * 1000))

      await runTransaction(db, async (transaction) => {
        const reservationItems: Array<{
          id: string
          name: string
          quantity: number
          price: number
        }> = []

        for (const cartItem of cart) {
          const inventoryRef = doc(db, 'inventory', cartItem.id)
          const inventorySnapshot = await transaction.get(inventoryRef)

          if (!inventorySnapshot.exists()) {
            throw new Error(`${cartItem.name} is no longer available.`)
          }

          const inventoryData = inventorySnapshot.data() as Record<string, unknown>
          const stock = Math.max(0, toNumber(inventoryData.stock ?? inventoryData.quantity, 0))
          const reservedStock = Math.max(0, toNumber(inventoryData.reservedStock, 0))
          const availableStock = Math.max(0, stock - reservedStock)

          if (cartItem.quantity > availableStock) {
            throw new Error(`Cannot reserve more than available stock for ${cartItem.name}.`)
          }

          transaction.update(inventoryRef, {
            reservedStock: reservedStock + cartItem.quantity,
            updatedAt: new Date().toISOString(),
          })

          reservationItems.push({
            id: cartItem.id,
            name: cartItem.name,
            quantity: cartItem.quantity,
            price: cartItem.price,
          })
        }

        transaction.set(reservationRef, {
          id: reservationRef.id,
          items: reservationItems,
          customer: customer.trim() || 'Walk-in Customer',
          status: 'Active',
          createdAt,
          expiresAt,
        })
      })

      setCart([])
      setCustomer('')
      setSuccessMessage('Reservation created successfully.')
    } catch (reservationError) {
      console.error('RESERVATION ERROR:', reservationError)
      setError(reservationError instanceof Error ? reservationError.message : 'Failed to create reservation.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="min-h-[calc(100vh-64px)] bg-slate-100 px-4 py-8 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-[1700px] space-y-6">
        <header>
          <h1 className="text-4xl font-bold text-slate-900">Sales POS</h1>
          <p className="mt-1 text-lg text-slate-600">Process sales and view transaction records.</p>
        </header>

        <section className="grid gap-6 xl:grid-cols-[1.5fr_1fr]">
          <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-200 p-5">
              <h2 className="text-xl font-semibold text-slate-900">Products</h2>
              <div className="mt-4 flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                <Search className="h-4 w-4 text-slate-500" />
                <input
                  type="text"
                  value={inventorySearch}
                  onChange={(event) => setInventorySearch(event.target.value)}
                  placeholder="Search products"
                  className="w-full bg-transparent text-sm text-slate-900 outline-none placeholder:text-slate-400"
                />
              </div>
            </div>

            <div className="max-h-[620px] overflow-y-auto p-5">
              <div className="grid gap-3 md:grid-cols-2">
                {filteredInventoryItems.map((item) => {
                  const inCart = cart.find((cartItem) => cartItem.id === item.id)
                  const isLowStock = item.availableStock > 0 && item.availableStock <= 5
                  const isOutOfStock = item.availableStock <= 0

                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => addToCart(item)}
                      disabled={isOutOfStock}
                      className={`rounded-2xl border p-4 text-left transition ${
                        isOutOfStock
                          ? 'cursor-not-allowed border-slate-200 bg-slate-100 opacity-70'
                          : isLowStock
                            ? 'border-amber-200 bg-amber-50 hover:border-amber-300'
                            : 'border-slate-200 bg-white hover:border-sky-300 hover:bg-sky-50/40'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <h3 className="font-semibold text-slate-900">{item.name}</h3>
                          <p className="mt-1 text-sm text-slate-500">{item.categoryName}</p>
                        </div>
                        {isOutOfStock ? (
                          <span className="rounded-full bg-red-100 px-2.5 py-1 text-xs font-semibold text-red-600">
                            Out of Stock
                          </span>
                        ) : isLowStock ? (
                          <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-700">
                            Low Stock
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-4 flex items-end justify-between gap-3">
                        <div>
                          <p className="text-lg font-bold text-slate-900">{currency(item.price)}</p>
                          <p className="text-sm text-slate-500">Available Stock: {item.availableStock}</p>
                        </div>
                        <div className="flex flex-col items-end gap-2">
                          {item.reservedStock > 0 ? (
                            <span className="rounded-full bg-violet-100 px-2.5 py-1 text-xs font-semibold text-violet-700">
                              Reserved: {item.reservedStock}
                            </span>
                          ) : null}
                          {inCart ? (
                            <span className="rounded-full bg-sky-100 px-2.5 py-1 text-xs font-semibold text-sky-700">
                              In cart: {inCart.quantity}
                            </span>
                          ) : (
                            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">
                              Add item
                            </span>
                          )}
                        </div>
                      </div>
                    </button>
                  )
                })}
              </div>

              {filteredInventoryItems.length === 0 ? (
                <p className="py-10 text-center text-sm text-slate-500">No inventory items match your search.</p>
              ) : null}
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-200 p-5">
              <div className="flex items-center gap-3">
                <ShoppingCart className="h-5 w-5 text-sky-700" />
                <div>
                  <h2 className="text-xl font-semibold text-slate-900">Cart</h2>
                  <p className="text-sm text-slate-500">{cart.length} item{cart.length === 1 ? '' : 's'} selected</p>
                </div>
              </div>

              <div className="mt-4">
                <label className="mb-1 block text-sm font-medium text-slate-700">Customer</label>
                <input
                  type="text"
                  value={customer}
                  onChange={(event) => setCustomer(event.target.value)}
                  placeholder="Walk-in Customer"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-slate-500"
                />
              </div>
            </div>

            <div className="max-h-[460px] space-y-3 overflow-y-auto p-5">
              {cart.length > 0 ? (
                cart.map((item) => (
                  <div key={item.id} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h3 className="font-semibold text-slate-900">{item.name}</h3>
                        <p className="text-sm text-slate-500">{item.categoryName}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => removeFromCart(item.id)}
                        className="text-slate-400 transition hover:text-red-600"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>

                    <div className="mt-4 flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => updateCartQuantity(item.id, item.quantity - 1)}
                          className="rounded-lg border border-slate-200 bg-white p-2 text-slate-700 transition hover:bg-slate-100"
                        >
                          <Minus className="h-4 w-4" />
                        </button>
                        <span className="min-w-8 text-center text-sm font-semibold text-slate-900">{item.quantity}</span>
                        <button
                          type="button"
                          onClick={() => updateCartQuantity(item.id, item.quantity + 1)}
                          disabled={item.quantity >= item.availableStock}
                          className="rounded-lg border border-slate-200 bg-white p-2 text-slate-700 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <Plus className="h-4 w-4" />
                        </button>
                      </div>

                      <div className="text-right">
                        <p className="text-sm text-slate-500">
                          {currency(item.price)} x {item.quantity}
                        </p>
                        <p className="font-semibold text-slate-900">{currency(item.price * item.quantity)}</p>
                      </div>
                    </div>
                  </div>
                ))
              ) : (
                <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-8 text-center">
                  <p className="text-sm text-slate-500">Add items to start a sale.</p>
                </div>
              )}
            </div>

            <div className="border-t border-slate-200 p-5">
              <div className="flex items-center justify-between text-lg font-semibold text-slate-900">
                <span>Total</span>
                <span>{currency(cartTotal)}</span>
              </div>

              {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}
              {successMessage ? <p className="mt-3 text-sm text-green-600">{successMessage}</p> : null}

              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={reserveOrder}
                  disabled={submitting || cart.length === 0}
                  className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-slate-900 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {submitting ? 'Processing...' : 'Reserve Order'}
                </button>
                <button
                  type="button"
                  onClick={completeSale}
                  disabled={submitting || cart.length === 0}
                  className="w-full rounded-xl bg-sky-900 px-4 py-3 text-sm font-semibold text-white transition hover:bg-sky-800 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {submitting ? 'Processing...' : 'Complete Sale'}
                </button>
              </div>
            </div>
          </div>
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
