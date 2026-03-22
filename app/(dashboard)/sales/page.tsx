'use client'

import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { collection, onSnapshot } from 'firebase/firestore'
import { toPng } from 'html-to-image'
import { Download, Mail, Minus, Plus, Search, ShoppingCart, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { auth, db } from '@/lib/firebase'
import ProtectedRoute from '@/components/ProtectedRoute'
import SalesFilters from '@/components/SalesFilters'
import SalesTable from '@/components/SalesTable'
import SalesViewModal from '@/components/SalesViewModal'
import TransactionDocument from '@/components/TransactionDocument'
import {
  buildGmailComposeLink,
  buildMailtoLink,
  CompletedTransactionDocument,
} from '@/lib/transactionDocuments'
import { normalizeInventoryCondition } from '@/lib/server/salesInventoryMetrics'

interface SaleTransaction {
  docId: string
  id: string
  receiptNumber: string
  customer: string
  customerEmail: string
  items: Array<{
    itemId?: string
    name: string
    quantity: number
    price: number
    categoryId: string
    categoryName?: string
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
  categoryName: string
  status: string
}

interface InventoryItem {
  id: string
  name: string
  categoryId?: string
  categoryName: string
  price: number
  condition: 'New' | 'Refurbished'
  stock: number
  reservedStock: number
  availableStock: number
  isDeleted?: boolean
}

interface Category {
  id: string
  name: string
}

interface CartItem {
  id: string
  name: string
  price: number
  quantity: number
  availableStock: number
  categoryName: string
  condition: 'New' | 'Refurbished'
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
  const [categories, setCategories] = useState<Category[]>([])
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [successMessage, setSuccessMessage] = useState('')

  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'completed' | 'voided'>('all')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [inventorySearch, setInventorySearch] = useState('')
  const [inventoryCategoryFilter, setInventoryCategoryFilter] = useState('all')
  const [inventoryConditionFilter, setInventoryConditionFilter] = useState<'all' | 'New' | 'Refurbished'>('all')
  const [inventoryStockStatusFilter, setInventoryStockStatusFilter] = useState<'all' | 'Available' | 'Low Stock' | 'Out of Stock'>('all')
  const [customerFullName, setCustomerFullName] = useState('')
  const [customerEmail, setCustomerEmail] = useState('')
  const [customerContactNumber, setCustomerContactNumber] = useState('')
  const [cart, setCart] = useState<CartItem[]>([])
  const [completedDocument, setCompletedDocument] = useState<CompletedTransactionDocument | null>(null)

  const [selectedTransaction, setSelectedTransaction] = useState<SaleTransaction | null>(null)
  const documentRef = useRef<HTMLDivElement | null>(null)
  const deferredSearch = useDeferredValue(search)

  useEffect(() => {
    const unsubscribeCategories = onSnapshot(
      collection(db, 'categories'),
      (snapshot) => {
        const list: Category[] = snapshot.docs
          .map((categoryDoc) => {
            const data = categoryDoc.data() as Record<string, unknown>
            return {
              id: categoryDoc.id,
              name: typeof data.name === 'string' ? data.name.trim() : '',
            }
          })
          .filter((item) => item.name)

        list.sort((a, b) => a.name.localeCompare(b.name))
        setCategories(list)
      },
      (snapshotError) => console.error('Error loading categories for sales:', snapshotError)
    )

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
                    categoryName:
                      typeof saleItem.categoryName === 'string' && saleItem.categoryName.trim()
                        ? saleItem.categoryName.trim()
                        : typeof saleItem.category === 'string' && saleItem.category.trim()
                          ? saleItem.category.trim()
                          : '',
                    status: typeof saleItem.status === 'string' ? saleItem.status : 'completed',
                  }
                })
                .filter((item): item is ParsedSaleItem => item !== null)
            : []

          return {
            docId: saleDoc.id,
            id: typeof data.id === 'string' && data.id.trim() ? data.id : saleDoc.id,
            receiptNumber:
              typeof data.receiptNumber === 'string' && data.receiptNumber.trim()
                ? data.receiptNumber.trim()
                : saleDoc.id,
            customer: typeof data.customer === 'string' && data.customer.trim() ? data.customer : 'Walk-in Customer',
            customerEmail: typeof data.customerEmail === 'string' ? data.customerEmail.trim() : '',
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
              condition: normalizeInventoryCondition(data.status),
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
      unsubscribeCategories()
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
            condition: liveItem.condition,
            quantity: Math.min(cartItem.quantity, liveItem.availableStock),
          }
        })
        .filter((item): item is CartItem => item !== null && item.availableStock > 0 && item.quantity > 0)
    )
  }, [inventoryItems])

  const searchableTransactions = useMemo(
    () =>
      transactions.map((transaction) => {
        const categoryNames = Array.from(
          new Set(transaction.items.map((item) => (item.categoryName ?? '').trim()).filter(Boolean))
        )

        return {
          transaction,
          categoryNames,
          searchIndex: [
            transaction.customer,
            transaction.id,
            transaction.receiptNumber,
            transaction.customerEmail,
            ...transaction.items.map((item) => item.name),
            ...categoryNames,
          ]
            .join(' ')
            .toLowerCase(),
        }
      }),
    [transactions]
  )

  const categoryOptions = useMemo(() => {
    const optionSet = new Set(categories.map((category) => category.name))

    transactions.forEach((transaction) => {
      transaction.items.forEach((item) => {
        const categoryName = (item.categoryName ?? '').trim()
        if (categoryName) {
          optionSet.add(categoryName)
        }
      })
    })

    return Array.from(optionSet).sort((a, b) => a.localeCompare(b))
  }, [categories, transactions])

  const filteredTransactions = useMemo(() => {
    const searchTerm = deferredSearch.trim().toLowerCase()
    const startTime = startDate ? new Date(startDate).getTime() : null
    const endTime = endDate ? new Date(new Date(endDate).setHours(23, 59, 59, 999)).getTime() : null

    return searchableTransactions
      .filter(({ transaction, categoryNames, searchIndex }) => {
        const matchesSearch = !searchTerm || searchIndex.includes(searchTerm)

        const matchesStatus = statusFilter === 'all' ? true : transaction.status === statusFilter

        const matchesCategory =
          categoryFilter === 'all' ? true : categoryNames.includes(categoryFilter)

        const transactionTime = transaction.createdAt?.getTime()
        const matchesDate =
          transactionTime == null
            ? !startTime && !endTime
            : (startTime == null || transactionTime >= startTime) && (endTime == null || transactionTime <= endTime)

        return matchesSearch && matchesStatus && matchesCategory && matchesDate
      })
      .map(({ transaction }) => transaction)
  }, [searchableTransactions, deferredSearch, statusFilter, categoryFilter, startDate, endDate])

  const filteredInventoryItems = useMemo(() => {
    const query = inventorySearch.trim().toLowerCase()

    return inventoryItems
      .filter((item) => {
        if (!query) return true
        return item.name.toLowerCase().includes(query) || item.categoryName.toLowerCase().includes(query)
      })
      .filter((item) => (inventoryCategoryFilter === 'all' ? true : item.categoryName === inventoryCategoryFilter))
      .filter((item) => (inventoryConditionFilter === 'all' ? true : item.condition === inventoryConditionFilter))
      .filter((item) => {
        if (inventoryStockStatusFilter === 'all') return true
        const stockStatus =
          item.availableStock <= 0 ? 'Out of Stock' : item.availableStock <= 5 ? 'Low Stock' : 'Available'
        return stockStatus === inventoryStockStatusFilter
      })
      .sort((a, b) => {
        const getPriority = (item: InventoryItem) => {
          if (item.availableStock <= 0) return 2
          if (item.availableStock <= 5) return 1
          return 0
        }

        const priorityDiff = getPriority(a) - getPriority(b)
        if (priorityDiff !== 0) return priorityDiff
        return a.name.localeCompare(b.name)
      })
  }, [
    inventoryItems,
    inventorySearch,
    inventoryCategoryFilter,
    inventoryConditionFilter,
    inventoryStockStatusFilter,
  ])

  const inventoryCategoryOptions = useMemo(
    () => Array.from(new Set(inventoryItems.map((item) => item.categoryName))).sort((a, b) => a.localeCompare(b)),
    [inventoryItems]
  )

  const cartTotal = useMemo(
    () => cart.reduce((sum, item) => sum + item.price * item.quantity, 0),
    [cart]
  )
  const isCompletedMode = completedDocument !== null
  const completedDocumentEmail = completedDocument?.customer.email.trim() ?? ''

  const exportDocumentAsImage = async () => {
    if (!documentRef.current || !completedDocument) return

    try {
      const dataUrl = await toPng(documentRef.current, {
        cacheBust: true,
        pixelRatio: 2,
        backgroundColor: '#ffffff',
      })
      const link = window.document.createElement('a')
      link.download =
        completedDocument.type === 'sale'
          ? `receipt-${completedDocument.receiptNumber}.png`
          : `reservation-${completedDocument.reservationCode}.png`
      link.href = dataUrl
      link.click()
      toast.success('Document image downloaded successfully.')
    } catch (imageError) {
      console.error('Failed to export document image:', imageError)
      toast.error('Failed to download the document image.')
    }
  }

  const openManualEmailLink = (target: 'gmail' | 'mailto') => {
    if (!completedDocument) return
    if (!completedDocumentEmail) {
      toast.error('No customer email is available for this transaction.')
      return
    }

    if (target === 'gmail') {
      window.open(buildGmailComposeLink(completedDocument), '_blank', 'noopener,noreferrer')
      return
    }

    window.location.href = buildMailtoLink(completedDocument)
  }

  const startNewTransaction = () => {
    setCompletedDocument(null)
    setError('')
    setSuccessMessage('')
  }

  const addToCart = (item: InventoryItem) => {
    if (isCompletedMode) return
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
          condition: item.condition,
        },
      ]
    })
  }

  const updateCartQuantity = (itemId: string, nextQuantity: number) => {
    if (isCompletedMode) return
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
    if (isCompletedMode) return
    setError('')
    setSuccessMessage('')
    setCart((currentCart) => currentCart.filter((item) => item.id !== itemId))
  }

  const completeSale = async () => {
    if (cart.length === 0) {
      setError('Cart is empty.')
      return
    }

    if (!customerFullName.trim() || !customerContactNumber.trim()) {
      setError('Customer full name and contact number are required.')
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
          customerDetails: {
            fullName: customerFullName.trim(),
            email: customerEmail.trim(),
            contactNumber: customerContactNumber.trim(),
          },
          processedBy: {
            uid: auth.currentUser?.uid ?? '',
            email: auth.currentUser?.email ?? '',
            name: auth.currentUser?.displayName ?? auth.currentUser?.email ?? '',
          },
        }),
      })

      const result = (await response.json()) as {
        error?: string
        document?: CompletedTransactionDocument
      }
      if (!response.ok) {
        throw new Error(result.error || 'Failed to complete sale.')
      }

      setCart([])
      setCustomerFullName('')
      setCustomerEmail('')
      setCustomerContactNumber('')
      setCompletedDocument(result.document ?? null)
      setSuccessMessage('Sale completed successfully.')
      toast.success('Sale completed successfully.')
    } catch (checkoutError) {
      console.error('SALE ERROR:', checkoutError)
      const message = checkoutError instanceof Error ? checkoutError.message : 'Failed to complete sale.'
      setError(message)
      toast.error(message)
    } finally {
      setSubmitting(false)
    }
  }

  const reserveOrder = async () => {
    if (cart.length === 0) {
      setError('Cart is empty.')
      return
    }

    if (!customerFullName.trim() || !customerContactNumber.trim()) {
      setError('Customer full name and contact number are required.')
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

      const response = await fetch('/api/reservations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: cart.map((item) => ({
            itemId: item.id,
            quantity: item.quantity,
          })),
          customerDetails: {
            fullName: customerFullName.trim(),
            email: customerEmail.trim(),
            contactNumber: customerContactNumber.trim(),
          },
          processedBy: {
            uid: auth.currentUser?.uid ?? '',
            email: auth.currentUser?.email ?? '',
            name: auth.currentUser?.displayName ?? auth.currentUser?.email ?? '',
          },
        }),
      })

      const result = (await response.json()) as {
        error?: string
        document?: CompletedTransactionDocument
      }
      if (!response.ok) {
        throw new Error(result.error || 'Failed to create reservation.')
      }

      setCart([])
      setCustomerFullName('')
      setCustomerEmail('')
      setCustomerContactNumber('')
      setCompletedDocument(result.document ?? null)
      setSuccessMessage('Reservation created successfully.')
      toast.success('Reservation created successfully.')
    } catch (reservationError) {
      console.error('RESERVATION ERROR:', reservationError)
      const message =
        reservationError instanceof Error ? reservationError.message : 'Failed to create reservation.'
      setError(message)
      toast.error(message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="min-h-[calc(100vh-64px)] bg-slate-100 px-2 py-2.5 sm:px-2.5">
      <div className="mx-auto max-w-[1620px] space-y-3.5">
        <header>
          <h1 className="text-[1.65rem] font-bold text-slate-900">Sales POS</h1>
        </header>

        <section className="grid gap-3.5 xl:grid-cols-[1.5fr_1fr]">
          <div className="rounded-2xl border border-slate-200/90 bg-white shadow-[0_10px_26px_rgba(59,76,117,0.08)]">
            <div className="border-b border-slate-200/90 bg-slate-50/70 p-4">
              <h2 className="text-lg font-semibold text-slate-900">Products</h2>
              <div className="mt-3 rounded-2xl border border-slate-200 bg-slate-50/60 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)]">
                <div className="flex items-center gap-2.5 rounded-xl border border-slate-200 bg-white px-3 py-2 shadow-sm">
                <Search className="h-4 w-4 text-slate-400" />
                <input
                  type="text"
                  value={inventorySearch}
                  onChange={(event) => setInventorySearch(event.target.value)}
                  placeholder="Search products"
                  className="w-full bg-transparent text-sm text-slate-900 outline-none placeholder:text-slate-400"
                />
                </div>
                <div className="mt-3 grid gap-2 sm:grid-cols-3">
                  <select
                    value={inventoryCategoryFilter}
                    onChange={(event) => setInventoryCategoryFilter(event.target.value)}
                    className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-[color:var(--primary)] focus:ring-2 focus:ring-[color:var(--primary)]/10"
                  >
                    <option value="all">All Categories</option>
                    {inventoryCategoryOptions.map((category) => (
                      <option key={category} value={category}>
                        {category}
                      </option>
                    ))}
                  </select>
                  <select
                    value={inventoryConditionFilter}
                    onChange={(event) =>
                      setInventoryConditionFilter(
                        event.target.value === 'New'
                          ? 'New'
                          : event.target.value === 'Refurbished'
                            ? 'Refurbished'
                            : 'all'
                      )
                    }
                    className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-[color:var(--primary)] focus:ring-2 focus:ring-[color:var(--primary)]/10"
                  >
                    <option value="all">All Conditions</option>
                    <option value="New">New</option>
                    <option value="Refurbished">Refurbished</option>
                  </select>
                  <select
                    value={inventoryStockStatusFilter}
                    onChange={(event) =>
                      setInventoryStockStatusFilter(
                        event.target.value === 'Available'
                          ? 'Available'
                          : event.target.value === 'Low Stock'
                            ? 'Low Stock'
                            : event.target.value === 'Out of Stock'
                              ? 'Out of Stock'
                              : 'all'
                      )
                    }
                    className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-[color:var(--primary)] focus:ring-2 focus:ring-[color:var(--primary)]/10"
                  >
                    <option value="all">All Stock Status</option>
                    <option value="Available">Available</option>
                    <option value="Low Stock">Low Stock</option>
                    <option value="Out of Stock">Out of Stock</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="max-h-[620px] overflow-y-auto p-4">
              <div className="grid gap-2.5 md:grid-cols-2">
                {filteredInventoryItems.map((item) => {
                  const inCart = cart.find((cartItem) => cartItem.id === item.id)
                  const isLowStock = item.availableStock > 0 && item.availableStock <= 5
                  const isOutOfStock = item.availableStock <= 0

                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => addToCart(item)}
                      disabled={isOutOfStock || isCompletedMode}
                      className={`rounded-2xl border p-3.5 text-left transition ${
                        isOutOfStock || isCompletedMode
                          ? 'cursor-not-allowed border-slate-200 bg-slate-100 opacity-70'
                          : isLowStock
                            ? 'border-amber-200 bg-amber-50 hover:border-amber-300'
                            : 'border-slate-200 bg-white hover:border-sky-300 hover:bg-sky-50/40'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2.5">
                        <div>
                          <h3 className="font-semibold text-slate-900">{item.name}</h3>
                          <p className="mt-0.5 text-xs text-slate-500">{item.categoryName}</p>
                          <p className="mt-1 text-xs font-medium text-slate-400">{item.condition}</p>
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
                      <div className="mt-3.5 flex items-end justify-between gap-2.5">
                        <div>
                          <p className="text-base font-bold text-slate-900">{currency(item.price)}</p>
                          <p className="text-xs text-slate-500">Available Stock: {item.availableStock}</p>
                        </div>
                        <div className="flex flex-col items-end gap-1.5">
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
                <p className="py-8 text-center text-sm text-slate-500">No inventory items match your search.</p>
              ) : null}
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200/90 bg-white shadow-[0_10px_26px_rgba(59,76,117,0.08)]">
            {isCompletedMode && completedDocument ? (
              <div className="p-4 sm:p-5">
                <div className="mb-3">
                  <div>
                    <h2 className="text-lg font-semibold text-slate-900">
                      {completedDocument.type === 'sale' ? 'Receipt Ready' : 'Reservation Ticket Ready'}
                    </h2>
                    <p className="mt-1 text-xs text-slate-400">
                      Send, download, or start a new transaction.
                    </p>
                  </div>
                </div>

                <TransactionDocument ref={documentRef} document={completedDocument} />

                <div className="mt-5 flex flex-wrap items-center gap-2.5">
                  <button
                    type="button"
                    onClick={() => openManualEmailLink('gmail')}
                    disabled={!completedDocumentEmail}
                    className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <Mail className="h-4 w-4" />
                    Send via Gmail
                  </button>
                  <button
                    type="button"
                    onClick={exportDocumentAsImage}
                    className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 transition hover:bg-slate-50"
                  >
                    <Download className="h-4 w-4" />
                    Download Image
                  </button>
                  <button
                    type="button"
                    onClick={startNewTransaction}
                    className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl bg-sky-900 px-4.5 py-2 text-sm font-semibold text-white transition hover:bg-sky-800 sm:ml-auto"
                  >
                    New Transaction
                  </button>
                </div>
                {!completedDocumentEmail ? (
                  <p className="mt-2.5 text-xs text-amber-700">
                    No customer email is available, so manual email sending is disabled for this transaction.
                  </p>
                ) : null}
              </div>
            ) : (
              <>
                <div className="border-b border-slate-200 p-4">
                  <div className="flex items-center gap-2.5">
                    <ShoppingCart className="h-5 w-5 text-sky-700" />
                    <div>
                      <h2 className="text-lg font-semibold text-slate-900">Cart</h2>
                      <p className="text-xs text-slate-500">{cart.length} item{cart.length === 1 ? '' : 's'} selected</p>
                    </div>
                  </div>

                  <div className="mt-3.5">
                    <label className="mb-1 block text-xs font-medium text-slate-700">Customer Full Name</label>
                    <input
                      type="text"
                      value={customerFullName}
                      onChange={(event) => setCustomerFullName(event.target.value)}
                      placeholder="Juan Dela Cruz"
                      className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-slate-500"
                    />
                  </div>
                  <div className="mt-2.5">
                    <label className="mb-1 block text-xs font-medium text-slate-700">Customer Email</label>
                    <input
                      type="email"
                      value={customerEmail}
                      onChange={(event) => setCustomerEmail(event.target.value)}
                      placeholder="Optional for manual email compose"
                      className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-slate-500"
                    />
                  </div>
                  <div className="mt-2.5">
                    <label className="mb-1 block text-xs font-medium text-slate-700">Customer Contact Number</label>
                    <input
                      type="text"
                      value={customerContactNumber}
                      onChange={(event) => setCustomerContactNumber(event.target.value)}
                      placeholder="09XXXXXXXXX"
                      className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-slate-500"
                    />
                  </div>
                </div>

                <div className="max-h-[460px] space-y-2.5 overflow-y-auto p-4">
                  {cart.length > 0 ? (
                    cart.map((item) => (
                      <div key={item.id} className="rounded-xl border border-slate-200 bg-slate-50 p-3.5">
                        <div className="flex items-start justify-between gap-2.5">
                          <div>
                            <h3 className="font-semibold text-slate-900">{item.name}</h3>
                            <p className="text-xs text-slate-500">{item.categoryName}</p>
                            <p className="text-xs text-slate-400">{item.condition}</p>
                          </div>
                          <button
                            type="button"
                            onClick={() => removeFromCart(item.id)}
                            className="text-slate-400 transition hover:text-red-600"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>

                        <div className="mt-3.5 flex items-center justify-between gap-2.5">
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => updateCartQuantity(item.id, item.quantity - 1)}
                              className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-700 transition hover:bg-slate-100"
                            >
                              <Minus className="h-4 w-4" />
                            </button>
                            <span className="min-w-8 text-center text-sm font-semibold text-slate-900">{item.quantity}</span>
                            <button
                              type="button"
                              onClick={() => updateCartQuantity(item.id, item.quantity + 1)}
                              disabled={item.quantity >= item.availableStock}
                              className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-700 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              <Plus className="h-4 w-4" />
                            </button>
                          </div>

                          <div className="text-right">
                            <p className="text-xs text-slate-500">
                              {currency(item.price)} x {item.quantity}
                            </p>
                            <p className="font-semibold text-slate-900">{currency(item.price * item.quantity)}</p>
                          </div>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-6 text-center">
                      <p className="text-sm text-slate-500">Add items to start a sale.</p>
                    </div>
                  )}
                </div>

                <div className="border-t border-slate-200/90 bg-slate-50/70 p-4">
                  <div className="rounded-2xl border border-slate-200/80 bg-white/90 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)]">
                  <div className="flex items-center justify-between text-base font-semibold text-slate-900">
                    <span>Total</span>
                    <span>{currency(cartTotal)}</span>
                  </div>

                  {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}
                  {successMessage ? <p className="mt-3 text-sm text-green-600">{successMessage}</p> : null}

                  <div className="mt-3.5 grid gap-2.5 sm:grid-cols-2">
                    <button
                      type="button"
                      onClick={reserveOrder}
                      disabled={submitting || cart.length === 0}
                      className="w-full rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-900 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {submitting ? 'Processing...' : 'Reserve Order'}
                    </button>
                    <button
                      type="button"
                      onClick={completeSale}
                      disabled={submitting || cart.length === 0}
                      className="w-full rounded-xl bg-[color:var(--primary)] px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-[color:var(--primary)]/92 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {submitting ? 'Processing...' : 'Complete Sale'}
                    </button>
                  </div>
                  </div>
                </div>
              </>
            )}
          </div>
        </section>

        <section className="rounded-xl border bg-white p-4 shadow-sm">
          <SalesFilters
            search={search}
            onSearchChange={setSearch}
            statusFilter={statusFilter}
            onStatusFilterChange={setStatusFilter}
            categoryFilter={categoryFilter}
            onCategoryFilterChange={setCategoryFilter}
            categoryOptions={categoryOptions}
            startDate={startDate}
            onStartDateChange={setStartDate}
            endDate={endDate}
            onEndDateChange={setEndDate}
          />
        </section>

        <section className="rounded-xl border bg-white p-4 shadow-sm">
          <SalesTable
            transactions={filteredTransactions}
            loading={loading}
            onView={(transaction) => setSelectedTransaction(transaction)}
            onVoid={() => Promise.resolve()}
            voidingId={null}
          />
        </section>
      </div>

      <SalesViewModal transaction={selectedTransaction} onClose={() => setSelectedTransaction(null)} />
    </main>
  )
}
