'use client'

import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { collection, onSnapshot } from 'firebase/firestore'
import { toPng } from 'html-to-image'
import { Download, Mail, Minus, Plus, Printer, Search, ShoppingCart, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { auth, db } from '@/lib/firebase'
import ProtectedRoute from '@/components/shared/ProtectedRoute'
import SalesFilters from '@/components/sales/SalesFilters'
import SalesTable from '@/components/sales/SalesTable'
import SalesViewModal from '@/components/sales/SalesViewModal'
import TransactionDocument from '@/components/sales/TransactionDocument'
import {
  buildGmailComposeLink,
  CompletedTransactionDocument,
  ReceiptRecord,
} from '@/lib/transactions/transactionDocuments'
import { normalizeInventoryCondition, toDate, toNumber } from '@/lib/server/salesInventoryMetrics'
import { openReceiptPrintWindow } from '@/lib/transactions/receiptPrint'

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
    condition: string
  }>
  totalAmount: number
  status: 'completed' | 'voided' | 'refunded'
  createdAt: Date | null
}

interface ParsedSaleItem {
  itemId: string | undefined
  name: string
  quantity: number
  price: number
  categoryId: string
  categoryName: string
  condition: string
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
  isVoided?: boolean
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
  const [activeReceipt, setActiveReceipt] = useState<ReceiptRecord | null>(null)

  const [selectedTransaction, setSelectedTransaction] = useState<SaleTransaction | null>(null)
  const [showEmailModal, setShowEmailModal] = useState(false)
  const [emailModalInput, setEmailModalInput] = useState('')
  const [emailSending, setEmailSending] = useState(false)
  const [emailModalError, setEmailModalError] = useState('')
  // Pagination for products table and discount for cart
  const [inventoryPage, setInventoryPage] = useState(1)
  const [discount, setDiscount] = useState(0)
  const [showAllSalesModal, setShowAllSalesModal] = useState(false)
  const [showRefundConfirm, setShowRefundConfirm] = useState(false)
  const [refundReason, setRefundReason] = useState('')
  const [refundLoading, setRefundLoading] = useState(false)
  const ITEMS_PER_PAGE = 10
  const documentRef = useRef<HTMLDivElement | null>(null)
  const deferredSearch = useDeferredValue(search)

  const RECEIPT_STORAGE_KEY = 'sustain-invi2-activeReceipt'

  useEffect(() => {
    const saved = window.localStorage.getItem(RECEIPT_STORAGE_KEY)
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as ReceiptRecord
        setActiveReceipt(parsed)
        setCompletedDocument(parsed.document)
        return
      } catch (jsonError) {
        console.warn('Failed to parse saved receipt from localStorage:', jsonError)
      }
    }

    ;(async () => {
      try {
        const response = await fetch('/api/receipts?status=active&limit=1')
        if (!response.ok) return
        const payload = (await response.json()) as { data?: ReceiptRecord[] }
        const [latest] = payload.data ?? []
        if (latest) {
          setActiveReceipt(latest)
          setCompletedDocument(latest.document)
        }
      } catch (fetchError) {
        console.error('Error loading latest active receipt:', fetchError)
      }
    })()
  }, [])

  useEffect(() => {
    if (activeReceipt) {
      window.localStorage.setItem(RECEIPT_STORAGE_KEY, JSON.stringify(activeReceipt))
    } else {
      window.localStorage.removeItem(RECEIPT_STORAGE_KEY)
    }
  }, [activeReceipt])

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
                    condition: saleItem.condition,
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
            status: parsedStatus === 'voided' ? 'voided' : parsedStatus === 'refunded' ? 'refunded' : 'completed',
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
              condition: normalizeInventoryCondition(data.condition),
              stock: Math.max(0, toNumber(data.stock ?? data.quantity, 0)),
              reservedStock: Math.max(0, toNumber(data.reservedStock, 0)),
              availableStock: Math.max(
                0,
                Math.max(0, toNumber(data.stock ?? data.quantity, 0)) - Math.max(0, toNumber(data.reservedStock, 0))
              ),
              isDeleted: data.isDeleted === true,
              isVoided: data.isVoided === true,
            }
          })
          .filter((item) => item.name && item.isDeleted !== true && item.isVoided !== true)

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

  // Reset to page 1 when filters or search change
  useEffect(() => {
    setInventoryPage(1)
  }, [inventorySearch, inventoryCategoryFilter, inventoryConditionFilter, inventoryStockStatusFilter])

  // Slice filtered items for the current page
  const paginatedItems = useMemo(
    () => filteredInventoryItems.slice((inventoryPage - 1) * ITEMS_PER_PAGE, inventoryPage * ITEMS_PER_PAGE),
    [filteredInventoryItems, inventoryPage]
  )

  const totalInventoryPages = Math.max(1, Math.ceil(filteredInventoryItems.length / ITEMS_PER_PAGE))

  const inventoryCategoryOptions = useMemo(
    () => Array.from(new Set(inventoryItems.map((item) => item.categoryName))).sort((a, b) => a.localeCompare(b)),
    [inventoryItems]
  )

  const cartSubtotal = useMemo(
    () => cart.reduce((sum, item) => sum + item.price * item.quantity, 0),
    [cart]
  )
  const cartTotal = Math.max(0, cartSubtotal - discount)
  const isCompletedMode = completedDocument !== null
  const completedDocumentEmail = completedDocument?.customer.email.trim() ?? ''

  const handleRefund = async () => {
    if (!selectedTransaction) return
    setRefundLoading(true)
    try {
      const res = await fetch('/api/sales/refund', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          saleId: selectedTransaction.docId,
          reason: refundReason.trim() || 'Refund processed',
        }),
      })
      const data = await res.json() as { error?: string }
      if (!res.ok) {
        toast.error(data.error ?? 'Failed to process refund')
        return
      }
      toast.success(`Refund processed for ${selectedTransaction.receiptNumber}`)
      setSelectedTransaction(null)
      setShowRefundConfirm(false)
      setRefundReason('')
    } catch {
      toast.error('Network error. Please try again.')
    } finally {
      setRefundLoading(false)
    }
  }

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

  const openManualEmailLink = () => {
    if (!completedDocument) return
    if (!completedDocumentEmail) {
      // No email on record — open modal to enter one first
      setEmailModalInput('')
      setEmailModalError('')
      setShowEmailModal(true)
      return
    }
    openGmailCompose(completedDocumentEmail)
  }

  const openGmailCompose = (email: string) => {
    if (!completedDocument) return
    // Override the customer email in the document so the Gmail link uses the entered email
    const docWithEmail = {
      ...completedDocument,
      customer: { ...completedDocument.customer, email },
    }
    window.open(buildGmailComposeLink(docWithEmail), '_blank', 'noopener,noreferrer')
    setShowEmailModal(false)
  }

  const startNewTransaction = () => {
    setCart([])
    setCompletedDocument(null)
    setActiveReceipt(null)
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
        receipt?: ReceiptRecord
      }
      if (!response.ok) {
        throw new Error(result.error || 'Failed to complete sale.')
      }

      setCart([])
      setCustomerFullName('')
      setCustomerEmail('')
      setCustomerContactNumber('')
      const active = result.receipt ?? null
      setActiveReceipt(active)
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
        receipt?: ReceiptRecord
      }
      if (!response.ok) {
        throw new Error(result.error || 'Failed to create reservation.')
      }

      setCart([])
      setCustomerFullName('')
      setCustomerEmail('')
      setCustomerContactNumber('')
      const active = result.receipt ?? null
      setActiveReceipt(active)
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
    <main className="h-[calc(100vh-64px)] overflow-hidden bg-slate-50 flex flex-col">
      <div className="mx-auto w-full max-w-[1400px] flex flex-col h-full px-4 pt-4 pb-3 gap-3">

        {/* ── Header ── */}
        <div className="flex flex-wrap items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" />
              </svg>
            </div>
            <div>
              <h1 className="text-xl font-bold text-slate-900">Sales POS</h1>
              <p className="text-xs text-slate-500">Search products, add to cart, and complete sales transactions.</p>
            </div>
          </div>
          <button
            type="button"
            onClick={startNewTransaction}
            className="flex items-center gap-2 rounded-lg bg-[#1e3a5f] px-3.5 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-[#162d4a]"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            New Transaction
          </button>
        </div>

        {/* ── Error / success banners ── */}
        {error ? (
          <div className="shrink-0 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>
        ) : null}
        {successMessage ? (
          <div className="shrink-0 rounded-lg border border-green-200 bg-green-50 px-4 py-2 text-sm text-green-700">{successMessage}</div>
        ) : null}

        {/* ── Two-column layout — fills remaining viewport ── */}
        <div className="grid grid-cols-1 xl:grid-cols-[1fr_370px] gap-3 flex-1 min-h-0 overflow-hidden">

          {/* ══ LEFT COLUMN ══ */}
          <div className="flex flex-col gap-3 min-h-0 overflow-hidden">

            {/* Products card */}
            <div className="rounded-2xl border border-slate-200 bg-white shadow-sm flex flex-col flex-1 min-h-0">
              {/* Card header */}
              <div className="border-b border-slate-100 px-4 py-3 shrink-0">
                <h2 className="text-sm font-semibold text-slate-900">Products</h2>
              </div>

              {/* Search + filters */}
              <div className="px-4 pt-3 pb-2 space-y-2 shrink-0">
                <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 shadow-sm">
                  <svg className="h-4 w-4 shrink-0 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <circle cx="11" cy="11" r="8" /><path strokeLinecap="round" d="M21 21l-4.35-4.35" />
                  </svg>
                  <input
                    type="text"
                    value={inventorySearch}
                    onChange={(e) => setInventorySearch(e.target.value)}
                    placeholder="Search products..."
                    className="w-full bg-transparent text-sm text-slate-800 outline-none placeholder:text-slate-400"
                  />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={inventoryCategoryFilter}
                    onChange={(e) => setInventoryCategoryFilter(e.target.value)}
                    className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 focus:outline-none"
                  >
                    <option value="all">All Categories</option>
                    {inventoryCategoryOptions.map((cat) => (
                      <option key={cat} value={cat}>{cat}</option>
                    ))}
                  </select>
                  <select
                    value={inventoryConditionFilter}
                    onChange={(e) => setInventoryConditionFilter(e.target.value === 'New' ? 'New' : e.target.value === 'Refurbished' ? 'Refurbished' : 'all')}
                    className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 focus:outline-none"
                  >
                    <option value="all">All Conditions</option>
                    <option value="New">New</option>
                    <option value="Refurbished">Refurbished</option>
                  </select>
                  <select
                    value={inventoryStockStatusFilter}
                    onChange={(e) => setInventoryStockStatusFilter(e.target.value === 'Available' ? 'Available' : e.target.value === 'Low Stock' ? 'Low Stock' : e.target.value === 'Out of Stock' ? 'Out of Stock' : 'all')}
                    className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 focus:outline-none"
                  >
                    <option value="all">All Stock</option>
                    <option value="Available">In Stock</option>
                    <option value="Low Stock">Low Stock</option>
                    <option value="Out of Stock">Out of Stock</option>
                  </select>
                  <button
                    type="button"
                    onClick={() => { setInventorySearch(''); setInventoryCategoryFilter('all'); setInventoryConditionFilter('all'); setInventoryStockStatusFilter('all') }}
                    className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-600 transition hover:bg-slate-50"
                  >
                    <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                    Reset
                  </button>
                </div>
              </div>

              {/* Products table — internal scroll */}
              <div className="overflow-auto flex-1 min-h-0">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-slate-50 text-xs font-medium text-slate-500 z-10">
                    <tr>
                      <th className="px-4 py-2.5 text-left">Product Name</th>
                      <th className="px-4 py-2.5 text-left">Category</th>
                      <th className="px-4 py-2.5 text-left">Condition</th>
                      <th className="px-4 py-2.5 text-right">Price</th>
                      <th className="px-4 py-2.5 text-right">Stock</th>
                      <th className="px-4 py-2.5 text-center">Status</th>
                      <th className="px-4 py-2.5 text-center">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {loading ? (
                      <tr><td colSpan={7} className="py-8 text-center text-sm text-slate-400">Loading products...</td></tr>
                    ) : paginatedItems.length === 0 ? (
                      <tr><td colSpan={7} className="py-8 text-center text-sm text-slate-400">No products match your filters.</td></tr>
                    ) : (
                      paginatedItems.map((item) => {
                        const isOutOfStock = item.availableStock <= 0
                        const isLowStock = item.availableStock > 0 && item.availableStock <= 5
                        return (
                          <tr key={item.id} className="hover:bg-slate-50">
                            <td className="px-4 py-2.5 font-medium text-slate-900">{item.name}</td>
                            <td className="px-4 py-2.5 text-slate-500 text-xs">{item.categoryName}</td>
                            <td className="px-4 py-2.5">
                              <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${item.condition === 'New' ? 'bg-green-50 text-green-700' : 'bg-orange-50 text-orange-600'}`}>
                                {item.condition}
                              </span>
                            </td>
                            <td className="px-4 py-2.5 text-right font-medium text-slate-800 text-xs">{currency(item.price)}</td>
                            <td className="px-4 py-2.5 text-right text-slate-600 text-xs">{item.availableStock}</td>
                            <td className="px-4 py-2.5 text-center">
                              <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${isOutOfStock ? 'bg-red-50 text-red-600' : isLowStock ? 'bg-amber-50 text-amber-600' : 'bg-green-50 text-green-700'}`}>
                                {isOutOfStock ? 'Out of Stock' : isLowStock ? 'Low Stock' : 'In Stock'}
                              </span>
                            </td>
                            <td className="px-4 py-2.5 text-center">
                              <button
                                type="button"
                                onClick={() => addToCart(item)}
                                disabled={isOutOfStock || isCompletedMode}
                                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 transition hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                              >
                                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" />
                                </svg>
                                Add
                              </button>
                            </td>
                          </tr>
                        )
                      })
                    )}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              {filteredInventoryItems.length > 0 ? (
                <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 border-t border-slate-100 shrink-0 text-xs text-slate-500">
                  <span>
                    {((inventoryPage - 1) * ITEMS_PER_PAGE) + 1}–{Math.min(inventoryPage * ITEMS_PER_PAGE, filteredInventoryItems.length)} of {filteredInventoryItems.length}
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setInventoryPage((p) => Math.max(1, p - 1))}
                      disabled={inventoryPage === 1}
                      className="flex h-7 w-7 items-center justify-center rounded border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                    >
                      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
                    </button>
                    {Array.from({ length: totalInventoryPages }, (_, i) => i + 1)
                      .filter((page) => {
                        if (totalInventoryPages <= 5) return true
                        if (page === 1 || page === totalInventoryPages) return true
                        if (Math.abs(page - inventoryPage) <= 1) return true
                        return false
                      })
                      .reduce<Array<number | '...'>>((acc, page, idx, arr) => {
                        if (idx > 0 && typeof arr[idx - 1] === 'number' && (page as number) - (arr[idx - 1] as number) > 1) acc.push('...')
                        acc.push(page)
                        return acc
                      }, [])
                      .map((item, idx) =>
                        item === '...' ? (
                          <span key={`e-${idx}`} className="flex h-7 w-7 items-center justify-center text-slate-400">…</span>
                        ) : (
                          <button
                            key={item}
                            type="button"
                            onClick={() => setInventoryPage(item as number)}
                            className={`flex h-7 w-7 items-center justify-center rounded border text-xs font-medium transition ${inventoryPage === item ? 'border-[#1e3a5f] bg-[#1e3a5f] text-white' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}
                          >
                            {item}
                          </button>
                        )
                      )}
                    <button
                      type="button"
                      onClick={() => setInventoryPage((p) => Math.min(totalInventoryPages, p + 1))}
                      disabled={inventoryPage === totalInventoryPages}
                      className="flex h-7 w-7 items-center justify-center rounded border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                    >
                      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
                    </button>
                  </div>
                </div>
              ) : null}
            </div>

            {/* Recent Sales card */}
            <div className="rounded-2xl border border-slate-200 bg-white shadow-sm shrink-0">
              <div className="border-b border-slate-100 px-4 py-3">
                <h2 className="text-sm font-semibold text-slate-900">Recent Sales</h2>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-xs font-medium text-slate-500">
                    <tr>
                      <th className="px-4 py-2.5 text-left">Receipt No.</th>
                      <th className="px-4 py-2.5 text-left">Date &amp; Time</th>
                      <th className="px-4 py-2.5 text-left">Customer</th>
                      <th className="px-4 py-2.5 text-right">Items</th>
                      <th className="px-4 py-2.5 text-right">Total Amount</th>
                      <th className="px-4 py-2.5 text-center">Status</th>
                      <th className="px-4 py-2.5 text-center">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {transactions.length === 0 ? (
                      <tr><td colSpan={7} className="py-6 text-center text-xs text-slate-400">No recent sales.</td></tr>
                    ) : (
                      transactions.slice(0, 5).map((tx) => (
                        <tr key={tx.id} className="hover:bg-slate-50">
                          <td className="px-4 py-2.5 text-xs font-medium text-slate-800">{tx.receiptNumber || tx.id.slice(0, 12)}</td>
                          <td className="px-4 py-2.5 text-xs text-slate-500">
                            {tx.createdAt ? new Date(tx.createdAt).toLocaleString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }) : '—'}
                          </td>
                          <td className="px-4 py-2.5 text-xs text-slate-700">{tx.customer ?? '—'}</td>
                          <td className="px-4 py-2.5 text-right text-xs text-slate-600">
                            {Array.isArray(tx.items) ? tx.items.reduce((sum: number, item: { quantity: number }) => sum + (item.quantity ?? 0), 0) : '—'}
                          </td>
                          <td className="px-4 py-2.5 text-right text-xs font-medium text-slate-900">{currency(tx.totalAmount ?? 0)}</td>
                          <td className="px-4 py-2.5 text-center">
                            <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${tx.status === 'voided' ? 'bg-red-50 text-red-600' : 'bg-green-50 text-green-700'}`}>
                              {tx.status === 'voided' ? 'Voided' : 'Completed'}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-center">
                            <button type="button" onClick={() => setSelectedTransaction(tx)} className="text-slate-400 hover:text-slate-600">
                              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                              </svg>
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
              {transactions.length > 5 ? (
                <div className="border-t border-slate-100 px-4 py-2.5">
                  <button type="button" onClick={() => setShowAllSalesModal(true)} className="flex items-center gap-1.5 text-xs font-medium text-blue-600 hover:text-blue-500">
                    View all sales
                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M17 8l4 4m0 0l-4 4m4-4H3" /></svg>
                  </button>
                </div>
              ) : null}
            </div>
          </div>

          {/* ══ RIGHT COLUMN — scrollable internally ══ */}
          <div className="flex flex-col gap-3 overflow-y-auto min-h-0 pr-0.5">

            {/* ── Sale Complete: full receipt view ── */}
            {isCompletedMode && completedDocument ? (
              <div className="flex flex-col gap-3">
                {/* Success header */}
                <div className="flex items-center justify-between rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 shadow-sm">
                  <div className="flex items-center gap-2.5">
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-500 text-white shadow">
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    </div>
                    <div>
                      <p className="text-sm font-bold text-emerald-800">
                        {completedDocument.type === 'sale' ? 'Sale Completed' : 'Reservation Created'}
                      </p>
                      <p className="text-xs text-emerald-600">
                        {completedDocument.type === 'sale'
                          ? completedDocument.receiptNumber
                          : completedDocument.reservationCode}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={startNewTransaction}
                    className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 transition-colors"
                  >
                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                    </svg>
                    New Transaction
                  </button>
                </div>

                {/* Quick Actions — compact row */}
                <div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-2.5 shadow-sm">
                  <span className="mr-1 text-xs font-semibold text-slate-500">Actions:</span>
                  <button
                    type="button"
                    onClick={exportDocumentAsImage}
                    className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 transition-colors"
                  >
                    <svg className="h-3.5 w-3.5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                    </svg>
                    Download
                  </button>
                  <button
                    type="button"
                    onClick={() => completedDocument && openReceiptPrintWindow(completedDocument)}
                    className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 transition-colors"
                  >
                    <svg className="h-3.5 w-3.5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
                    </svg>
                    Print
                  </button>
                  <button
                    type="button"
                    onClick={() => openManualEmailLink()}
                    className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 transition-colors"
                  >
                    <svg className="h-3.5 w-3.5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                    </svg>
                    Email
                  </button>
                </div>

                {/* Full receipt */}
                <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
                  <div className="border-b border-slate-100 bg-slate-50 px-4 py-2.5">
                    <p className="text-xs font-semibold text-slate-600">
                      {completedDocument.type === 'sale' ? 'Official Receipt' : 'Reservation Ticket'}
                    </p>
                  </div>
                  <div className="overflow-y-auto" style={{ maxHeight: 'calc(100vh - 320px)' }}>
                    <TransactionDocument ref={documentRef} document={completedDocument} />
                  </div>
                </div>
              </div>
            ) : null}

            {/* Cart — hidden when sale is complete */}
            {!isCompletedMode ? (
            <>{/* Cart */}
            <div className="rounded-2xl border border-slate-200 bg-white shadow-sm shrink-0">
              <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
                <div className="flex items-center gap-2">
                  <svg className="h-4 w-4 text-[#1e3a5f]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" />
                  </svg>
                  <span className="text-sm font-semibold text-slate-900">
                    Cart <span className="font-normal text-slate-400 text-xs">({cart.length} {cart.length === 1 ? 'item' : 'items'})</span>
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => { setCart([]); setDiscount(0) }}
                  disabled={cart.length === 0 || isCompletedMode}
                  className="flex items-center gap-1 text-xs font-medium text-red-500 hover:text-red-600 disabled:opacity-40"
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                  Clear
                </button>
              </div>

              {/* Cart items — max height scroll */}
              <div className="max-h-48 overflow-y-auto divide-y divide-slate-50 px-4">
                {cart.length === 0 ? (
                  <p className="py-5 text-center text-xs text-slate-400">Your cart is empty.</p>
                ) : (
                  cart.map((item) => (
                    <div key={item.id} className="flex items-start gap-2 py-2.5">
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium text-slate-900 leading-tight">{item.name}</p>
                        <p className="text-xs text-slate-400">{item.condition} · {currency(item.price)}</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <button type="button" onClick={() => updateCartQuantity(item.id, item.quantity - 1)} disabled={isCompletedMode} className="flex h-5 w-5 items-center justify-center rounded border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-40">
                          <svg className="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M20 12H4" /></svg>
                        </button>
                        <span className="w-5 text-center text-xs font-medium text-slate-800">{item.quantity}</span>
                        <button type="button" onClick={() => updateCartQuantity(item.id, item.quantity + 1)} disabled={isCompletedMode || item.quantity >= item.availableStock} className="flex h-5 w-5 items-center justify-center rounded border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-40">
                          <svg className="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" /></svg>
                        </button>
                      </div>
                      <div className="shrink-0">
                        <p className="text-xs font-semibold text-slate-900">{currency(item.price * item.quantity)}</p>
                      </div>
                      <button type="button" onClick={() => removeFromCart(item.id)} disabled={isCompletedMode} className="shrink-0 text-slate-300 hover:text-slate-500 disabled:opacity-40">
                        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                      </button>
                    </div>
                  ))
                )}
              </div>

              {/* Totals */}
              <div className="border-t border-slate-100 px-4 py-3 space-y-1.5">
                <div className="flex items-center justify-between text-xs text-slate-600">
                  <span>Subtotal</span>
                  <span className="font-medium">{currency(cartSubtotal)}</span>
                </div>
                <div className="flex items-center justify-between text-xs text-slate-600">
                  <span>Discount</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={discount}
                    onChange={(e) => setDiscount(Math.max(0, Number(e.target.value)))}
                    disabled={isCompletedMode}
                    className="w-20 rounded border border-slate-200 px-2 py-1 text-right text-xs text-slate-700 focus:outline-none disabled:opacity-60"
                  />
                </div>
                <div className="flex items-center justify-between border-t border-slate-100 pt-1.5">
                  <span className="text-sm font-semibold text-slate-900">Total</span>
                  <span className="text-base font-bold text-[#1e3a5f]">{currency(cartTotal)}</span>
                </div>
              </div>

              {/* Action buttons */}
              <div className="px-4 pb-4 space-y-2">
                <button
                  type="button"
                  onClick={completeSale}
                  disabled={submitting || cart.length === 0 || isCompletedMode}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#1e3a5f] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[#162d4a] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  {submitting ? 'Processing...' : 'Complete Sale'}
                </button>
                <button
                  type="button"
                  onClick={reserveOrder}
                  disabled={submitting || cart.length === 0 || isCompletedMode}
                  className="flex w-full items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                  </svg>
                  Reserve Order
                </button>
              </div>
            </div>

            {/* Customer Information */}
            <div className="rounded-2xl border border-slate-200 bg-white shadow-sm shrink-0">
              <div className="border-b border-slate-100 px-4 py-3">
                <div className="flex items-center gap-2">
                  <svg className="h-4 w-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                  </svg>
                  <span className="text-sm font-semibold text-slate-900">Customer Information</span>
                </div>
              </div>
              <div className="px-4 py-3 space-y-2.5">
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-600">Name <span className="font-normal text-slate-400">(Optional)</span></label>
                  <input
                    type="text"
                    value={customerFullName}
                    onChange={(e) => setCustomerFullName(e.target.value)}
                    placeholder="Customer name"
                    disabled={isCompletedMode}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-blue-400 focus:outline-none disabled:opacity-60"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-600">Email <span className="font-normal text-slate-400">(Optional)</span></label>
                  <input
                    type="email"
                    value={customerEmail}
                    onChange={(e) => setCustomerEmail(e.target.value)}
                    placeholder="Email address"
                    disabled={isCompletedMode}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-blue-400 focus:outline-none disabled:opacity-60"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-600">Phone <span className="font-normal text-slate-400">(Optional)</span></label>
                  <input
                    type="tel"
                    value={customerContactNumber}
                    onChange={(e) => setCustomerContactNumber(e.target.value)}
                    placeholder="09XXXXXXXXX"
                    disabled={isCompletedMode}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-blue-400 focus:outline-none disabled:opacity-60"
                  />
                </div>
              </div>
            </div>



            </>
            ) : null}

          </div>
        </div>

      </div>

      {/* ── Transaction detail modal ── */}
      {selectedTransaction ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-200 p-4">
              <div>
                <h2 className="font-semibold text-slate-900">Transaction Detail</h2>
                <p className="text-xs text-slate-500">{selectedTransaction.receiptNumber || selectedTransaction.id}</p>
              </div>
              <button type="button" onClick={() => { setSelectedTransaction(null); setShowRefundConfirm(false); setRefundReason('') }} className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50">Close</button>
            </div>
            <div className="p-4 space-y-3 text-sm">
              <div className="flex justify-between"><span className="text-slate-500">Customer</span><span className="font-medium">{selectedTransaction.customer ?? '—'}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">Total</span><span className="font-semibold">{currency(selectedTransaction.totalAmount ?? 0)}</span></div>
              <div className="flex justify-between items-center">
                <span className="text-slate-500">Status</span>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${selectedTransaction.status === 'voided' ? 'bg-red-50 text-red-600' : selectedTransaction.status === 'refunded' ? 'bg-amber-50 text-amber-700' : 'bg-green-50 text-green-700'}`}>
                  {selectedTransaction.status === 'voided' ? 'Voided' : selectedTransaction.status === 'refunded' ? 'Refunded' : 'Completed'}
                </span>
              </div>
              {Array.isArray(selectedTransaction.items) && selectedTransaction.items.length > 0 ? (
                <div>
                  <p className="mb-2 font-medium text-slate-700">Items</p>
                  <table className="w-full text-xs">
                    <thead><tr className="border-b border-slate-100 text-slate-400"><th className="pb-1 text-left">Product</th><th className="pb-1 text-right">Qty</th><th className="pb-1 text-right">Price</th></tr></thead>
                    <tbody>
                      {selectedTransaction.items.map((item, idx) => (
                        <tr key={idx} className="border-b border-slate-50">
                          <td className="py-1 text-slate-700">{item.name}</td>
                          <td className="py-1 text-right text-slate-600">{item.quantity}</td>
                          <td className="py-1 text-right font-medium">{currency(item.price ?? 0)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}

              {/* Refund section */}
              {selectedTransaction.status === 'completed' && (
                <div className="pt-2">
                  {!showRefundConfirm ? (
                    <button
                      type="button"
                      onClick={() => setShowRefundConfirm(true)}
                      className="w-full rounded-lg border border-amber-300 bg-amber-50 py-2 text-sm font-semibold text-amber-700 hover:bg-amber-100 transition"
                    >
                      Process Refund
                    </button>
                  ) : (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-2">
                      <p className="text-xs font-semibold text-amber-800">Items will be restocked automatically</p>
                      <input
                        type="text"
                        value={refundReason}
                        onChange={(e) => setRefundReason(e.target.value)}
                        placeholder="Reason for refund (optional)"
                        className="w-full rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs text-slate-800 outline-none focus:border-amber-500"
                      />
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={handleRefund}
                          disabled={refundLoading}
                          className="flex-1 rounded-lg bg-red-600 py-1.5 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-60 transition"
                        >
                          {refundLoading ? 'Processing…' : 'Confirm Refund'}
                        </button>
                        <button
                          type="button"
                          onClick={() => { setShowRefundConfirm(false); setRefundReason('') }}
                          className="rounded-lg border px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 transition"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {/* ── View all sales modal ── */}
      {showAllSalesModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="flex max-h-[85vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-200 p-4 shrink-0">
              <h2 className="font-semibold text-slate-900">All Sales</h2>
              <button type="button" onClick={() => setShowAllSalesModal(false)} className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50">Close</button>
            </div>
            <div className="overflow-y-auto flex-1">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-slate-50 text-xs font-medium text-slate-500">
                  <tr>
                    <th className="px-4 py-3 text-left">Receipt No.</th>
                    <th className="px-4 py-3 text-left">Date &amp; Time</th>
                    <th className="px-4 py-3 text-left">Customer</th>
                    <th className="px-4 py-3 text-right">Items</th>
                    <th className="px-4 py-3 text-right">Total</th>
                    <th className="px-4 py-3 text-center">Status</th>
                    <th className="px-4 py-3 text-center">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {filteredTransactions.map((tx) => (
                    <tr key={tx.id} className="hover:bg-slate-50">
                      <td className="px-4 py-3 font-medium text-slate-800">{tx.receiptNumber || tx.id.slice(0, 12)}</td>
                      <td className="px-4 py-3 text-slate-500 text-xs">{tx.createdAt ? new Date(tx.createdAt).toLocaleString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }) : '—'}</td>
                      <td className="px-4 py-3 text-slate-700">{tx.customer ?? '—'}</td>
                      <td className="px-4 py-3 text-right text-slate-600">{Array.isArray(tx.items) ? tx.items.reduce((sum: number, item: { quantity: number }) => sum + (item.quantity ?? 0), 0) : '—'}</td>
                      <td className="px-4 py-3 text-right font-medium text-slate-900">{currency(tx.totalAmount ?? 0)}</td>
                      <td className="px-4 py-3 text-center">
                        <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${tx.status === 'voided' ? 'bg-red-50 text-red-600' : tx.status === 'refunded' ? 'bg-amber-50 text-amber-700' : 'bg-green-50 text-green-700'}`}>
                          {tx.status === 'voided' ? 'Voided' : tx.status === 'refunded' ? 'Refunded' : 'Completed'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-center">
                        <button type="button" onClick={() => { setSelectedTransaction(tx); setShowAllSalesModal(false) }} className="text-slate-400 hover:text-slate-600">
                          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : null}

      {/* Email Modal */}
      {showEmailModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white shadow-xl">
            <div className="border-b border-slate-200 px-5 py-4">
              <h2 className="font-semibold text-slate-900">Send Receipt</h2>
              <p className="mt-0.5 text-xs text-slate-500">Enter the customer email to send the receipt from JMGS Japon Surplus.</p>
            </div>
            <div className="px-5 py-4 space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">Customer Email Address</label>
                <input
                  type="email"
                  value={emailModalInput}
                  onChange={(e) => { setEmailModalInput(e.target.value); setEmailModalError('') }}
                  placeholder="customer@email.com"
                  autoFocus
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-blue-400 focus:outline-none"
                  onKeyDown={(e) => { if (e.key === 'Enter' && emailModalInput.trim()) openGmailCompose(emailModalInput.trim()) }}
                />
                {emailModalError && <p className="mt-1.5 text-xs text-red-600">{emailModalError}</p>}
                <p className="mt-1.5 text-[11px] text-slate-400">This will open Gmail with the receipt pre-filled.</p>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-5 py-3">
              <button
                type="button"
                onClick={() => setShowEmailModal(false)}
                className="rounded-lg border border-slate-200 px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => { if (emailModalInput.trim()) openGmailCompose(emailModalInput.trim()) }}
                disabled={!emailModalInput.trim()}
                className="flex items-center gap-2 rounded-lg bg-blue-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/>
                </svg>
                Open Gmail
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  )
}
