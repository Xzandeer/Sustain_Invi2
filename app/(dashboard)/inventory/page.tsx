'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { collection, onSnapshot } from 'firebase/firestore'
import { Plus, Tags, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { auth, db } from '@/lib/firebase'
import ProtectedRoute from '@/components/shared/ProtectedRoute'
import ProductTable, { Product } from '@/components/inventory/ProductTable'
import ProductModal, { ProductFormValues } from '@/components/inventory/ProductModal'
import StockAdjustmentModal from '@/components/inventory/StockAdjustmentModal'
import CategoryModal from '@/components/categories/CategoryModal'
import { useUserRole } from '@/hooks/useUserRole'
import { getStockStatus, normalizeInventoryCondition } from '@/lib/server/salesInventoryMetrics'

interface Category {
  id: string
  name: string
}

interface ContainerOption {
  id: string
  name: string
}

const toNumber = (value: unknown, fallback = 0) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

export default function ItemsPage() {
  return (
    <ProtectedRoute>
      <InventoryContent />
    </ProtectedRoute>
  )
}

function InventoryContent() {
  const { isAdmin, can } = useUserRole()
  const canManageInventory = isAdmin || can('canManageInventory')
  const canVoid = isAdmin || can('canVoidItems')
  const [inventory, setInventory] = useState<Product[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [containers, setContainers] = useState<ContainerOption[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [conditionFilter, setConditionFilter] = useState('all')
  const [stockStatusFilter, setStockStatusFilter] = useState('all')
  const [minPrice, setMinPrice] = useState('')
  const [maxPrice, setMaxPrice] = useState('')
  const [sortBy, setSortBy] = useState<'recent' | 'name' | 'price_low' | 'price_high'>('recent')

  const [isProductModalOpen, setIsProductModalOpen] = useState(false)
  const [isCategoryModalOpen, setIsCategoryModalOpen] = useState(false)
  const [isAdjustmentModalOpen, setIsAdjustmentModalOpen] = useState(false)
  const [editingProduct, setEditingProduct] = useState<Product | null>(null)
  const [adjustingProduct, setAdjustingProduct] = useState<Product | null>(null)

  const [savingProduct, setSavingProduct] = useState(false)
  const [adjustingStock, setAdjustingStock] = useState(false)
  const [deletingProductId, setDeletingProductId] = useState<string | null>(null)
  const [deletingCategoryId, setDeletingCategoryId] = useState<string | null>(null)
  const [addingCategory, setAddingCategory] = useState(false)
  const [voidTab, setVoidTab] = useState<'active' | 'voided' | 'all'>('active')
  const [voidingProduct, setVoidingProduct] = useState<Product | null>(null)
  const [voidingId, setVoidingId] = useState<string | null>(null)

  useEffect(() => {
    const unsubscribeCategories = onSnapshot(
      collection(db, 'categories'),
      (snapshot) => {
        const list: Category[] = snapshot.docs
          .map((docItem) => {
            const data = docItem.data() as Record<string, unknown>
            return {
              id: docItem.id,
              name: typeof data.name === 'string' ? data.name.trim() : '',
            }
          })
          .filter((item) => item.name)
        list.sort((a, b) => a.name.localeCompare(b.name))
        setCategories(list)
      },
      (snapshotError) => {
        console.error('Error loading categories:', snapshotError)
      }
    )

    const unsubscribeInventory = onSnapshot(
      collection(db, 'inventory'),
      (snapshot) => {
        const list: Product[] = snapshot.docs
          .map((docItem) => {
            const data = docItem.data() as Record<string, unknown>
            return {
              id: docItem.id,
              categoryId: typeof data.categoryId === 'string' ? data.categoryId : '',
              name: typeof data.name === 'string' ? data.name.trim() : '',
              category:
                (typeof data.categoryName === 'string' && data.categoryName.trim()) ||
                (typeof data.category === 'string' && data.category.trim()) ||
                'Uncategorized',
              price: Math.max(0, toNumber(data.price, 0)),
              quantity: Math.max(0, toNumber(data.stock ?? data.quantity, 0)),
              reservedStock: Math.max(0, toNumber(data.reservedStock, 0)),
              availableStock: Math.max(
                0,
                Math.max(0, toNumber(data.stock ?? data.quantity, 0)) - Math.max(0, toNumber(data.reservedStock, 0))
              ),
              minStock: Math.max(0, toNumber(data.minStock, 0)),
              condition: normalizeInventoryCondition(data.condition),
              description: typeof data.description === 'string' ? data.description.trim() : '',
              imageUrl: typeof data.imageUrl === 'string' ? data.imageUrl.trim() : '',
              stockStatus: getStockStatus(data),
              isDeleted: data.isDeleted === true,
              isVoided: data.isVoided === true,
              voidedAt: typeof data.voidedAt === 'string' ? data.voidedAt : null,
              voidedBy: typeof data.voidedBy === 'string' ? data.voidedBy : null,
              voidReason: typeof data.voidReason === 'string' ? data.voidReason : null,
              createdAtMs: (() => {
                const raw = data.createdAt as { seconds?: number } | string | undefined
                if (raw && typeof raw === 'object' && typeof raw.seconds === 'number') return raw.seconds * 1000
                if (typeof raw === 'string') { const t = Date.parse(raw); return Number.isNaN(t) ? 0 : t }
                return 0
              })(),
            }
          })
          .filter((item) => item.name && item.isDeleted !== true)

        list.sort((a, b) => a.name.localeCompare(b.name))
        setInventory(list)
        setLoading(false)
      },
      (snapshotError) => {
        console.error('Error loading inventory:', snapshotError)
        setLoading(false)
      }
    )

    const unsubscribeContainers = onSnapshot(
      collection(db, 'containers'),
      (snapshot) => {
        const list: ContainerOption[] = snapshot.docs
          .map((d) => {
            const data = d.data() as Record<string, unknown>
            return { id: d.id, name: typeof data.name === 'string' ? data.name.trim() : '' }
          })
          .filter((c) => c.name)
        list.sort((a, b) => a.name.localeCompare(b.name))
        setContainers(list)
      }
    )

    return () => {
      unsubscribeCategories()
      unsubscribeInventory()
      unsubscribeContainers()
    }
  }, [])

  const filteredProducts = useMemo(() => {
    const searchTerm = search.trim().toLowerCase()
    const minPriceValue = minPrice ? Number(minPrice) : null
    const maxPriceValue = maxPrice ? Number(maxPrice) : null

    const tabFiltered = inventory.filter((product) => {
      if (voidTab === 'active') return !product.isVoided
      if (voidTab === 'voided') return product.isVoided === true
      return true // 'all'
    })
    return tabFiltered
      .filter((product) => {
        if (!searchTerm) return true
        return (
          product.name.toLowerCase().includes(searchTerm) ||
          product.category.toLowerCase().includes(searchTerm)
        )
      })
      .filter((product) => (categoryFilter === 'all' ? true : product.category === categoryFilter))
      .filter((product) => (conditionFilter === 'all' ? true : product.condition === conditionFilter))
      .filter((product) => (stockStatusFilter === 'all' ? true : product.stockStatus === stockStatusFilter))
      .filter((product) =>
        minPriceValue == null || Number.isNaN(minPriceValue) ? true : product.price >= minPriceValue
      )
      .filter((product) =>
        maxPriceValue == null || Number.isNaN(maxPriceValue) ? true : product.price <= maxPriceValue
      )
      .sort((a, b) => {
        if (sortBy === 'recent') return (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0)
        if (sortBy === 'name') return a.name.localeCompare(b.name)
        if (sortBy === 'price_low') return a.price - b.price
        return b.price - a.price
      })
  }, [inventory, search, categoryFilter, conditionFilter, stockStatusFilter, minPrice, maxPrice, voidTab, sortBy])

  const handleSaveProduct = async (values: ProductFormValues) => {
    setError('')
    setSavingProduct(true)
    try {
      const category = categories.find((item) => item.id === values.categoryId)
      if (!category) {
        throw new Error('Please select a valid category.')
      }

      const targetUrl = editingProduct ? `/api/inventory/${editingProduct.id}` : '/api/inventory'
      const method = editingProduct ? 'PUT' : 'POST'
      const response = await fetch(targetUrl, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: values.name,
          categoryId: values.categoryId,
          categoryName: category.name,
          price: values.price,
          quantity: values.quantity,
          minStock: values.minStock,
          condition: values.condition,
          containerId: values.containerId ?? null,
          processedBy: {
            uid: auth.currentUser?.uid ?? '',
            email: auth.currentUser?.email ?? '',
            name: auth.currentUser?.displayName ?? auth.currentUser?.email ?? '',
          },
        }),
      })

      const payload = (await response.json()) as { error?: string }
      if (!response.ok) {
        throw new Error(payload.error || 'Failed to save item.')
      }

      setIsProductModalOpen(false)
      setEditingProduct(null)
      toast.success(editingProduct ? 'Item updated successfully.' : 'Inventory item added successfully.')
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : 'Failed to save item.'
      setError(message)
      toast.error(message)
    } finally {
      setSavingProduct(false)
    }
  }

  const handleDeleteProduct = async (productId: string) => {
    if (!isAdmin) return
    setError('')
    setDeletingProductId(productId)
    try {
      const response = await fetch(`/api/inventory/${productId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          processedBy: {
            uid: auth.currentUser?.uid ?? '',
            email: auth.currentUser?.email ?? '',
            name: auth.currentUser?.displayName ?? auth.currentUser?.email ?? '',
          },
        }),
      })
      const payload = (await response.json()) as { error?: string }
      if (!response.ok) {
        throw new Error(payload.error || 'Failed to move item to trash.')
      }
      toast.success('Item moved to trash.')
    } catch (deleteError) {
      const message = deleteError instanceof Error ? deleteError.message : 'Failed to move item to trash.'
      setError(message)
      toast.error(message)
    } finally {
      setDeletingProductId(null)
    }
  }

  const handleVoidProduct = async (productId: string, voidReason: string, voidQuantity: number) => {
    if (!isAdmin) return
    setError('')
    setVoidingId(productId)
    try {
      const response = await fetch(`/api/inventory/${productId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'void',
          voidReason,
          voidQuantity,
          processedBy: {
            uid: auth.currentUser?.uid ?? '',
            email: auth.currentUser?.email ?? '',
            name: auth.currentUser?.displayName ?? auth.currentUser?.email ?? '',
          },
        }),
      })
      const payload = (await response.json()) as { error?: string; isFullVoid?: boolean; newStock?: number }
      if (!response.ok) throw new Error(payload.error || 'Failed to void item.')
      toast.success(payload.isFullVoid ? 'Item fully voided.' : `${voidQuantity} unit${voidQuantity !== 1 ? 's' : ''} voided — stock updated.`)
      setVoidingProduct(null)
    } catch (voidError) {
      const message = voidError instanceof Error ? voidError.message : 'Failed to void item.'
      setError(message)
      toast.error(message)
    } finally {
      setVoidingId(null)
    }
  }

  const handleUnvoidProduct = async (productId: string) => {
    if (!isAdmin) return
    setError('')
    setVoidingId(productId)
    try {
      const response = await fetch(`/api/inventory/${productId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'unvoid',
          processedBy: {
            uid: auth.currentUser?.uid ?? '',
            email: auth.currentUser?.email ?? '',
            name: auth.currentUser?.displayName ?? auth.currentUser?.email ?? '',
          },
        }),
      })
      const payload = (await response.json()) as { error?: string }
      if (!response.ok) throw new Error(payload.error || 'Failed to restore item.')
      toast.success('Item restored successfully.')
    } catch (unvoidError) {
      const message = unvoidError instanceof Error ? unvoidError.message : 'Failed to restore item.'
      setError(message)
      toast.error(message)
    } finally {
      setVoidingId(null)
    }
  }

  const handleAddCategory = async (name: string) => {
    if (!isAdmin) return
    setAddingCategory(true)
    setError('')
    try {
      const response = await fetch('/api/categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      })
      const payload = (await response.json()) as { error?: string }
      if (!response.ok) {
        throw new Error(payload.error || 'Failed to add category.')
      }
      toast.success('Category added successfully.')
    } catch (categoryError) {
      const message = categoryError instanceof Error ? categoryError.message : 'Failed to add category.'
      setError(message)
      toast.error(message)
    } finally {
      setAddingCategory(false)
    }
  }

  const handleDeleteCategory = async (categoryId: string) => {
    if (!isAdmin) return
    setDeletingCategoryId(categoryId)
    setError('')
    try {
      const response = await fetch(`/api/categories/${categoryId}`, { method: 'DELETE' })
      const payload = (await response.json()) as { error?: string }
      if (!response.ok) {
        throw new Error(payload.error || 'Failed to delete category.')
      }
      toast.success('Category deleted successfully.')
    } catch (categoryError) {
      const message = categoryError instanceof Error ? categoryError.message : 'Failed to delete category.'
      setError(message)
      toast.error(message)
    } finally {
      setDeletingCategoryId(null)
    }
  }

  const openEditModal = (product: Product) => {
    setEditingProduct(product)
    setIsProductModalOpen(true)
  }

  const openAdjustModal = (product: Product) => {
    setAdjustingProduct(product)
    setIsAdjustmentModalOpen(true)
  }

  const handleAdjustStock = async (values: {
    action: 'add' | 'deduct' | 'transfer'
    quantity: number
    targetCondition?: 'New' | 'Refurbished'
    remarks: string
  }) => {
    if (!adjustingProduct) return

    setAdjustingStock(true)
    setError('')
    try {
      const response = await fetch(`/api/inventory/${adjustingProduct.id}/adjust`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...values,
          processedBy: {
            uid: auth.currentUser?.uid ?? '',
            email: auth.currentUser?.email ?? '',
            name: auth.currentUser?.displayName ?? auth.currentUser?.email ?? '',
          },
        }),
      })

      const payload = (await response.json()) as { error?: string }
      if (!response.ok) {
        throw new Error(payload.error || 'Failed to adjust stock.')
      }

      setIsAdjustmentModalOpen(false)
      setAdjustingProduct(null)
      const successMessage =
        values.action === 'add'
          ? 'Inventory adjusted: stock added.'
          : values.action === 'deduct'
            ? 'Inventory adjusted: stock deducted.'
            : 'Stock transferred successfully.'
      toast.success(successMessage)
    } catch (adjustError) {
      const message = adjustError instanceof Error ? adjustError.message : 'Failed to adjust stock.'
      setError(message)
      toast.error(message)
    } finally {
      setAdjustingStock(false)
    }
  }

  const categoryOptions = useMemo(() => categories, [categories])
  const categoryNames = useMemo(() => categories.map((category) => category.name), [categories])


  // ── Pagination state ──────────────────────────────
  const [currentPage, setCurrentPage] = useState(1)
  const [itemsPerPage, setItemsPerPage] = useState(10)

  // Reset to page 1 when filters change
  useEffect(() => { setCurrentPage(1) }, [search, categoryFilter, conditionFilter, stockStatusFilter, minPrice, maxPrice])

  const totalPages = Math.max(1, Math.ceil(filteredProducts.length / itemsPerPage))
  const paginatedProducts = useMemo(
    () => filteredProducts.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage),
    [filteredProducts, currentPage, itemsPerPage]
  )

  // ── KPI cards ─────────────────────────────────────
  const kpiTotal        = inventory.length
  const kpiAvailable    = inventory.filter((p) => p.stockStatus === 'Available').length
  const kpiReserved     = inventory.filter((p) => p.reservedStock > 0).length
  const kpiLowStock     = inventory.filter((p) => p.stockStatus === 'Low Stock').length
  const kpiOutOfStock   = inventory.filter((p) => p.stockStatus === 'Out of Stock').length

  // ── Export CSV ────────────────────────────────────
  const exportCSV = () => {
    // Quote any field containing a comma, quote or newline so columns stay aligned
    const esc = (v: unknown) => {
      const str = String(v ?? '')
      return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str
    }
    const headers = ['Item Name', 'Category', 'Condition', 'Price', 'Stock', 'Reserved', 'Available', 'Min Stock', 'Status']
    const rows = filteredProducts.map((p) => [
      p.name, p.category, p.condition,
      p.price.toFixed(2), p.quantity, p.reservedStock, p.availableStock, p.minStock, p.stockStatus,
    ])
    const csv = [headers, ...rows].map((r) => r.map(esc).join(',')).join('\n')
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `inventory-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const formatPrice = (v: number) =>
    v.toLocaleString('en-PH', { style: 'currency', currency: 'PHP', minimumFractionDigits: 2 })

  return (
    <main className="min-h-[calc(100vh-64px)] bg-slate-50 px-3 py-3 sm:px-5 sm:py-4">
      <div className="mx-auto max-w-[1400px] space-y-3 sm:space-y-4">

        {/* ── Page header ── */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
              <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
              </svg>
            </div>
            <div>
              <h1 className="text-lg font-bold text-slate-900 sm:text-2xl">Inventory</h1>
              <p className="text-sm text-slate-500">Manage your inventory items and track stock availability.</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/inventory/trash"
              className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50"
            >
              <svg className="h-4 w-4 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
              View Trash
            </Link>
            {canManageInventory && (
              <button
                onClick={() => { setEditingProduct(null); setIsProductModalOpen(true) }}
                className="inline-flex items-center gap-2 rounded-lg bg-[#1e3a5f] px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-[#162d4a]"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                </svg>
                Add Inventory Item
              </button>
            )}
          </div>
        </div>

        {/* ── Filters card ── */}
        <div className="rounded-2xl border border-slate-200 bg-white p-3 sm:p-4 shadow-sm space-y-3">
          {/* Row 1: search + dropdowns */}
          <div className="flex flex-wrap gap-3">
            <div className="relative flex flex-1 min-w-52 items-center">
              <svg className="absolute left-3 h-4 w-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <circle cx="11" cy="11" r="8" /><path strokeLinecap="round" d="M21 21l-4.35-4.35" />
              </svg>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by item name or category..."
                className="w-full rounded-lg border border-slate-200 py-2.5 pl-9 pr-3 text-sm text-slate-800 placeholder:text-slate-400 focus:border-blue-400 focus:outline-none"
              />
            </div>
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-700 focus:outline-none"
            >
              <option value="all">All Categories</option>
              {categoryNames.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
            <select
              value={conditionFilter}
              onChange={(e) => setConditionFilter(e.target.value)}
              className="rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-700 focus:outline-none"
            >
              <option value="all">All Conditions</option>
              <option value="New">New</option>
              <option value="Refurbished">Refurbished</option>
            </select>
            <select
              value={stockStatusFilter}
              onChange={(e) => setStockStatusFilter(e.target.value)}
              className="rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-700 focus:outline-none"
            >
              <option value="all">All Status</option>
              <option value="Available">Available</option>
              <option value="Low Stock">Low Stock</option>
              <option value="Out of Stock">Out of Stock</option>
            </select>
          </div>
          {/* Row 2: price range */}
          <div className="flex flex-wrap gap-3">
            <input
              type="number"
              min={0}
              value={minPrice}
              onChange={(e) => setMinPrice(e.target.value)}
              placeholder="Min price"
              className="w-40 rounded-lg border border-slate-200 px-3 py-2.5 text-sm text-slate-800 placeholder:text-slate-400 focus:border-blue-400 focus:outline-none"
            />
            <input
              type="number"
              min={0}
              value={maxPrice}
              onChange={(e) => setMaxPrice(e.target.value)}
              placeholder="Max price"
              className="w-40 rounded-lg border border-slate-200 px-3 py-2.5 text-sm text-slate-800 placeholder:text-slate-400 focus:border-blue-400 focus:outline-none"
            />
            <select
              value={sortBy}
              onChange={(e) => { setSortBy(e.target.value as typeof sortBy); setCurrentPage(1) }}
              className="w-48 rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 focus:border-blue-400 focus:outline-none"
            >
              <option value="recent">Recently Added</option>
              <option value="name">Name (A–Z)</option>
              <option value="price_low">Price (Low to High)</option>
              <option value="price_high">Price (High to Low)</option>
            </select>
          </div>
          {/* Row 3: action buttons */}
          <div className="flex flex-wrap items-center gap-2">
            {canManageInventory && (
              <button
                onClick={() => setIsCategoryModalOpen(true)}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
              >
                <svg className="h-4 w-4 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A2 2 0 013 12V7a2 2 0 012-2z" />
                </svg>
                Manage Categories
              </button>
            )}
            <button
              onClick={() => { setCurrentPage(1) }}
              className="inline-flex items-center gap-2 rounded-lg bg-[#1e3a5f] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#162d4a]"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2a1 1 0 01-.293.707L13 13.414V19a1 1 0 01-.553.894l-4 2A1 1 0 017 21v-7.586L3.293 6.707A1 1 0 013 6V4z" />
              </svg>
              Apply Filters
            </button>
            <button
              onClick={() => { setSearch(''); setCategoryFilter('all'); setConditionFilter('all'); setStockStatusFilter('all'); setMinPrice(''); setMaxPrice(''); setSortBy('recent') }}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
            >
              <svg className="h-4 w-4 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              Reset
            </button>
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>

        {/* ── Void filter tabs ── */}
        <div className="flex items-center gap-1 rounded-xl border border-slate-200 bg-white p-1 shadow-sm w-fit">
          {(['active', 'voided', 'all'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => { setVoidTab(tab); setCurrentPage(1) }}
              className={`rounded-lg px-4 py-1.5 text-sm font-medium transition ${
                voidTab === tab
                  ? 'bg-[#1e3a5f] text-white shadow-sm'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {tab === 'active' ? 'Active' : tab === 'voided' ? 'Voided' : 'All Items'}
            </button>
          ))}
        </div>

        {/* ── KPI cards ── */}
        <div className="grid grid-cols-2 gap-2 sm:gap-3 sm:grid-cols-3 xl:grid-cols-5">
          {/* Total Items */}
          <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-blue-50">
                <svg className="h-5 w-5 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                </svg>
              </div>
              <div>
                <p className="text-xs font-medium text-slate-500">Total Items</p>
                <p className="text-xl font-bold text-slate-900">{kpiTotal}</p>
                <p className="text-xs text-slate-400">All inventory items</p>
              </div>
            </div>
          </div>
          {/* Available Items */}
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-50">
                <svg className="h-5 w-5 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <div>
                <p className="text-xs font-medium text-slate-500">Available Items</p>
                <p className="text-xl font-bold text-slate-900">{kpiAvailable}</p>
                <p className="text-xs text-slate-400">Ready for sale</p>
              </div>
            </div>
          </div>
          {/* Reserved Items */}
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-50">
                <svg className="h-5 w-5 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                </svg>
              </div>
              <div>
                <p className="text-xs font-medium text-slate-500">Reserved Items</p>
                <p className="text-xl font-bold text-slate-900">{kpiReserved}</p>
                <p className="text-xs text-slate-400">On hold</p>
              </div>
            </div>
          </div>
          {/* Low Stock */}
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-violet-50">
                <svg className="h-5 w-5 text-violet-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              </div>
              <div>
                <p className="text-xs font-medium text-slate-500">Low Stock Items</p>
                <p className="text-xl font-bold text-slate-900">{kpiLowStock}</p>
                <p className="text-xs text-slate-400">Below minimum stock</p>
              </div>
            </div>
          </div>
          {/* Out of Stock */}
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-red-50">
                <svg className="h-5 w-5 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
                </svg>
              </div>
              <div>
                <p className="text-xs font-medium text-slate-500">Out of Stock</p>
                <p className="text-2xl font-bold text-slate-900">{kpiOutOfStock}</p>
                <p className="text-xs text-slate-400">Need restocking</p>
              </div>
            </div>
          </div>
        </div>

        {/* ── Inventory List ── */}
        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-slate-100 px-3 py-3">
            <h2 className="text-base font-semibold text-slate-900">Inventory List</h2>
            <div className="flex items-center gap-2">
              <button
                onClick={exportCSV}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
              >
                <svg className="h-4 w-4 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                Export
              </button>
              <button className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 hover:bg-slate-50">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 10h16M4 14h16M4 18h16" />
                </svg>
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            {loading ? (
              <p className="px-5 py-10 text-center text-sm text-slate-400">Loading products...</p>
            ) : filteredProducts.length === 0 ? (
              <p className="px-5 py-10 text-center text-sm text-slate-400">No products match your filters.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="border-b border-slate-100 bg-slate-50 text-xs font-medium text-slate-500">
                  <tr>
                    <th className="px-3 py-2 text-left">
                      <span className="flex items-center gap-1">Item Name
                        <svg className="h-3.5 w-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4" /></svg>
                      </span>
                    </th>
                    <th className="px-3 py-2 text-left">
                      <span className="flex items-center gap-1">Category
                        <svg className="h-3.5 w-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4" /></svg>
                      </span>
                    </th>
                    <th className="px-3 py-2 text-left">
                      <span className="flex items-center gap-1">Price
                        <svg className="h-3.5 w-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4" /></svg>
                      </span>
                    </th>
                    <th className="px-3 py-2 text-left">
                      <span className="flex items-center gap-1">Stock
                        <svg className="h-3.5 w-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                      </span>
                    </th>
                    <th className="px-3 py-2 text-left">
                      <span className="flex items-center gap-1">Reserved
                        <svg className="h-3.5 w-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                      </span>
                    </th>
                    <th className="px-3 py-2 text-left">
                      <span className="flex items-center gap-1">Available
                        <svg className="h-3.5 w-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4" /></svg>
                      </span>
                    </th>
                    <th className="px-3 py-2 text-left">Condition</th>
                    <th className="px-3 py-2 text-left">Stock Status</th>
                    <th className="px-3 py-2 text-left">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {paginatedProducts.map((product) => (
                    <tr key={product.id} className="hover:bg-slate-50">
                      <td className="px-5 py-3.5">
                        <p className="font-medium text-slate-900">{product.name}</p>
                        <p className="text-xs text-slate-400">Variant: {product.condition}</p>
                      </td>
                      <td className="px-5 py-3.5 text-slate-600">{product.category}</td>
                      <td className="px-5 py-3.5 font-medium text-slate-800">{formatPrice(product.price)}</td>
                      <td className="px-5 py-3.5">
                        <span className="font-semibold text-slate-900">{product.quantity}</span>
                        <span className="ml-1.5 text-xs text-slate-400">Min: {product.minStock}</span>
                      </td>
                      <td className="px-5 py-3.5 text-slate-600">{product.reservedStock}</td>
                      <td className="px-5 py-3.5">
                        <span className={`font-semibold ${product.availableStock > 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                          {product.availableStock}
                        </span>
                      </td>
                      <td className="px-5 py-3.5">
                        <span className={`inline-flex rounded-md px-2.5 py-0.5 text-xs font-semibold ${
                          product.condition === 'New' ? 'bg-blue-50 text-blue-700' : 'bg-slate-100 text-slate-600'
                        }`}>
                          {product.condition}
                        </span>
                      </td>
                      <td className="px-5 py-3.5">
                        <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                          product.stockStatus === 'Available'
                            ? 'bg-emerald-50 text-emerald-700'
                            : product.stockStatus === 'Low Stock'
                            ? 'bg-amber-50 text-amber-700'
                            : 'bg-red-50 text-red-600'
                        }`}>
                          <span className={`h-1.5 w-1.5 rounded-full ${
                            product.stockStatus === 'Available' ? 'bg-emerald-500'
                            : product.stockStatus === 'Low Stock' ? 'bg-amber-500'
                            : 'bg-red-500'
                          }`} />
                          {product.stockStatus}
                        </span>
                      </td>
                      <td className="px-5 py-3.5">
                        {(canManageInventory || canVoid) ? (
                          <div className="flex items-center gap-2">
                            {canManageInventory && (<>
                            <button
                              onClick={() => openEditModal(product)}
                              title="Edit"
                              className="flex h-7 w-7 items-center justify-center rounded-lg border border-slate-200 text-slate-500 transition hover:border-blue-300 hover:text-blue-600"
                            >
                              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                              </svg>
                            </button>
                            <button
                              onClick={() => openAdjustModal(product)}
                              title="Adjust stock"
                              className="flex h-7 w-7 items-center justify-center rounded-lg border border-slate-200 text-slate-500 transition hover:border-amber-300 hover:text-amber-600"
                            >
                              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                              </svg>
                            </button>
                            </>)}
                            {canVoid && (product.isVoided ? (
                              <button
                                onClick={() => handleUnvoidProduct(product.id)}
                                disabled={voidingId === product.id}
                                title="Restore item"
                                className="flex h-7 items-center gap-1 rounded-lg border border-slate-200 px-2 text-xs font-medium text-slate-500 transition hover:border-emerald-300 hover:text-emerald-600 disabled:opacity-40"
                              >
                                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                                Restore
                              </button>
                            ) : (
                              <button
                                onClick={() => setVoidingProduct(product)}
                                disabled={voidingId === product.id}
                                title="Void item"
                                className="flex h-7 items-center gap-1 rounded-lg border border-slate-200 px-2 text-xs font-medium text-slate-500 transition hover:border-red-300 hover:text-red-600 disabled:opacity-40"
                              >
                                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" /></svg>
                                Void
                              </button>
                            ))}
                          </div>
                        ) : (
                          <span className="text-xs text-slate-400">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* ── Pagination ── */}
          {filteredProducts.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-5 py-3">
              <div className="flex items-center gap-2 text-sm text-slate-600">
                <span>Show</span>
                <select
                  value={itemsPerPage}
                  onChange={(e) => { setItemsPerPage(Number(e.target.value)); setCurrentPage(1) }}
                  className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-sm text-slate-700 focus:outline-none"
                >
                  {[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
                <span>entries</span>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                  className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 transition hover:bg-slate-50 disabled:opacity-40"
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
                </button>
                {Array.from({ length: totalPages }, (_, i) => i + 1)
                  .filter((p) => {
                    if (totalPages <= 5) return true
                    if (p === 1 || p === totalPages) return true
                    if (Math.abs(p - currentPage) <= 1) return true
                    return false
                  })
                  .reduce<Array<number | '...'>>((acc, p, i, arr) => {
                    if (i > 0 && typeof arr[i - 1] === 'number' && (p as number) - (arr[i - 1] as number) > 1) acc.push('...')
                    acc.push(p)
                    return acc
                  }, [])
                  .map((item, i) =>
                    item === '...' ? (
                      <span key={`e-${i}`} className="flex h-8 w-8 items-center justify-center text-slate-400">…</span>
                    ) : (
                      <button
                        key={item}
                        onClick={() => setCurrentPage(item as number)}
                        className={`flex h-8 w-8 items-center justify-center rounded-lg border text-sm font-medium transition ${
                          currentPage === item
                            ? 'border-[#1e3a5f] bg-[#1e3a5f] text-white'
                            : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                        }`}
                      >
                        {item}
                      </button>
                    )
                  )}
                <button
                  onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                  className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 transition hover:bg-slate-50 disabled:opacity-40"
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <ProductModal
        isOpen={isProductModalOpen}
        onClose={() => { setIsProductModalOpen(false); setEditingProduct(null) }}
        onSubmit={handleSaveProduct}
        categories={categoryOptions}
        containers={containers}
        initialValues={
          editingProduct
            ? {
                name: editingProduct.name,
                categoryId: editingProduct.categoryId,
                price: editingProduct.price,
                quantity: editingProduct.quantity,
                minStock: editingProduct.minStock,
                condition: editingProduct.condition,
                reservedStock: editingProduct.reservedStock,
                availableStock: editingProduct.availableStock,
                containerId: (editingProduct as Product & { containerId?: string }).containerId,
              }
            : undefined
        }
        submitting={savingProduct}
      />

      <CategoryModal
        isOpen={isCategoryModalOpen}
        onClose={() => setIsCategoryModalOpen(false)}
        categories={categories}
        onAdd={handleAddCategory}
        onDelete={handleDeleteCategory}
        deletingCategoryId={deletingCategoryId}
        adding={addingCategory}
      />

      <StockAdjustmentModal
        isOpen={isAdjustmentModalOpen}
        product={adjustingProduct}
        onClose={() => { setIsAdjustmentModalOpen(false); setAdjustingProduct(null) }}
        onSubmit={handleAdjustStock}
        submitting={adjustingStock}
      />

      {voidingProduct && (
        <VoidModal
          product={voidingProduct}
          submitting={voidingId === voidingProduct.id}
          onClose={() => setVoidingProduct(null)}
          onConfirm={(reason, qty) => handleVoidProduct(voidingProduct.id, reason, qty)}
        />
      )}
    </main>
  )
}

// ── VoidModal ──────────────────────────────────────────────────────────────────
const VOID_REASONS = [
  'Damaged',
  'Defective',
  'Supplier Pullout',
  'Duplicate Entry',
  'Wrong Item Encoding',
  'Discontinued',
  'Other',
]

function VoidModal({
  product,
  submitting,
  onClose,
  onConfirm,
}: {
  product: Product
  submitting: boolean
  onClose: () => void
  onConfirm: (reason: string, quantity: number) => void
}) {
  const [reason, setReason] = useState('')
  const [customReason, setCustomReason] = useState('')
  const [voidQuantity, setVoidQuantity] = useState(product.quantity)
  const [localError, setLocalError] = useState('')

  const effectiveReason = reason === 'Other' ? customReason.trim() : reason

  const handleSubmit = () => {
    if (!reason) { setLocalError('Please select a reason.'); return }
    if (reason === 'Other' && !customReason.trim()) { setLocalError('Please describe the reason.'); return }
    if (!voidQuantity || voidQuantity < 1 || voidQuantity > product.quantity) {
      setLocalError(`Quantity must be between 1 and ${product.quantity}.`)
      return
    }
    setLocalError('')
    onConfirm(effectiveReason, voidQuantity)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white shadow-xl">
        {/* Header */}
        <div className="flex items-start gap-3 border-b border-slate-100 p-5">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-red-50">
            <svg className="h-5 w-5 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-slate-900">Void Item</h2>
            <p className="mt-0.5 text-sm text-slate-500">
              This will mark <span className="font-medium text-slate-800">{product.name}</span> as voided. It will be removed from active listings but all history will be preserved.
            </p>
          </div>
        </div>

        {/* Body */}
        <div className="space-y-4 p-5">
          {/* Item summary */}
          <div className="rounded-xl border border-slate-100 bg-slate-50 px-4 py-3 text-sm">
            <div className="flex justify-between text-slate-500"><span>Category</span><span className="font-medium text-slate-800">{product.category}</span></div>
            <div className="mt-1 flex justify-between text-slate-500"><span>Condition</span><span className="font-medium text-slate-800">{product.condition}</span></div>
            <div className="mt-1 flex justify-between text-slate-500"><span>Stock</span><span className="font-medium text-slate-800">{product.quantity}</span></div>
          </div>

          {/* Quantity to void */}
          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-700">
              Quantity to Void <span className="text-red-500">*</span>
              <span className="ml-1 font-normal text-slate-400">(max: {product.quantity})</span>
            </label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setVoidQuantity((q) => Math.max(1, q - 1))}
                className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 transition-colors"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M20 12H4" /></svg>
              </button>
              <input
                type="number"
                min={1}
                max={product.quantity}
                value={voidQuantity}
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10)
                  if (!isNaN(val)) setVoidQuantity(Math.min(product.quantity, Math.max(1, val)))
                }}
                className="w-20 rounded-lg border border-slate-200 px-3 py-2 text-center text-sm font-medium text-slate-800 focus:border-[#1e3a5f] focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setVoidQuantity((q) => Math.min(product.quantity, q + 1))}
                className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 transition-colors"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" /></svg>
              </button>
              <span className="text-xs text-slate-400">of {product.quantity} units</span>
            </div>
            {voidQuantity === product.quantity && (
              <p className="mt-1.5 text-xs text-amber-600 font-medium">All units selected — item will be fully voided.</p>
            )}
            {voidQuantity < product.quantity && (
              <p className="mt-1.5 text-xs text-blue-600">Partial void — stock will be reduced by {voidQuantity} unit{voidQuantity !== 1 ? 's' : ''}.</p>
            )}
          </div>

          {/* Reason dropdown */}
          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-700">Void Reason <span className="text-red-500">*</span></label>
            <select
              value={reason}
              onChange={(e) => { setReason(e.target.value); setLocalError('') }}
              className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 focus:border-[#1e3a5f] focus:outline-none"
            >
              <option value="">Select a reason…</option>
              {VOID_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>

          {/* Custom reason */}
          {reason === 'Other' && (
            <div>
              <label className="mb-1.5 block text-sm font-medium text-slate-700">Describe the reason <span className="text-red-500">*</span></label>
              <textarea
                value={customReason}
                onChange={(e) => { setCustomReason(e.target.value); setLocalError('') }}
                rows={3}
                placeholder="Provide a specific reason for voiding this item..."
                className="w-full resize-none rounded-xl border border-slate-200 px-3 py-2.5 text-sm text-slate-800 placeholder:text-slate-400 focus:border-[#1e3a5f] focus:outline-none"
              />
            </div>
          )}

          {/* Warning */}
          <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5">
            <svg className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            </svg>
            <p className="text-xs text-amber-700">Voided items are hidden from Sales POS and Reservation creation but remain in stock logs, analytics, and history.</p>
          </div>

          {localError && <p className="text-sm text-red-600">{localError}</p>}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 border-t border-slate-100 p-4">
          <button
            onClick={onClose}
            disabled={submitting}
            className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="flex items-center gap-2 rounded-xl bg-red-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-700 disabled:opacity-50"
          >
            {submitting ? (
              <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>
            ) : (
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" /></svg>
            )}
            Void Item
          </button>
        </div>
      </div>
    </div>
  )
}
