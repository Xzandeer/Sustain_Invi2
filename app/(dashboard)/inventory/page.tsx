'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { collection, onSnapshot } from 'firebase/firestore'
import { Plus, Tags, Trash2 } from 'lucide-react'
import { db } from '@/lib/firebase'
import ProtectedRoute from '@/components/ProtectedRoute'
import ProductTable, { Product } from '@/components/ProductTable'
import ProductModal, { ProductFormValues } from '@/components/ProductModal'
import CategoryModal from '@/components/CategoryModal'
import { useUserRole } from '@/hooks/useUserRole'
import { getStockStatus, normalizeInventoryCondition } from '@/lib/server/salesInventoryMetrics'

interface Category {
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
  const { isAdmin } = useUserRole()
  const [inventory, setInventory] = useState<Product[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [conditionFilter, setConditionFilter] = useState('all')
  const [stockStatusFilter, setStockStatusFilter] = useState('all')
  const [minPrice, setMinPrice] = useState('')
  const [maxPrice, setMaxPrice] = useState('')

  const [isProductModalOpen, setIsProductModalOpen] = useState(false)
  const [isCategoryModalOpen, setIsCategoryModalOpen] = useState(false)
  const [editingProduct, setEditingProduct] = useState<Product | null>(null)

  const [savingProduct, setSavingProduct] = useState(false)
  const [deletingProductId, setDeletingProductId] = useState<string | null>(null)
  const [deletingCategoryId, setDeletingCategoryId] = useState<string | null>(null)
  const [addingCategory, setAddingCategory] = useState(false)

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
              minStock: Math.max(0, toNumber(data.minStock, 0)),
              condition: normalizeInventoryCondition(data.status),
              stockStatus: getStockStatus(data),
              isDeleted: data.isDeleted === true,
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

    return () => {
      unsubscribeCategories()
      unsubscribeInventory()
    }
  }, [])

  const filteredProducts = useMemo(() => {
    const searchTerm = search.trim().toLowerCase()
    const minPriceValue = minPrice ? Number(minPrice) : null
    const maxPriceValue = maxPrice ? Number(maxPrice) : null

    return inventory
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
  }, [inventory, search, categoryFilter, conditionFilter, stockStatusFilter, minPrice, maxPrice])

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
          status: values.condition,
        }),
      })

      const payload = (await response.json()) as { error?: string }
      if (!response.ok) {
        throw new Error(payload.error || 'Failed to save item.')
      }

      setIsProductModalOpen(false)
      setEditingProduct(null)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to save item.')
    } finally {
      setSavingProduct(false)
    }
  }

  const handleDeleteProduct = async (productId: string) => {
    if (!isAdmin) return
    setError('')
    setDeletingProductId(productId)
    try {
      const response = await fetch(`/api/inventory/${productId}`, { method: 'DELETE' })
      const payload = (await response.json()) as { error?: string }
      if (!response.ok) {
        throw new Error(payload.error || 'Failed to delete item.')
      }
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Failed to delete item.')
    } finally {
      setDeletingProductId(null)
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
    } catch (categoryError) {
      setError(categoryError instanceof Error ? categoryError.message : 'Failed to add category.')
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
    } catch (categoryError) {
      setError(categoryError instanceof Error ? categoryError.message : 'Failed to delete category.')
    } finally {
      setDeletingCategoryId(null)
    }
  }

  const openEditModal = (product: Product) => {
    setEditingProduct(product)
    setIsProductModalOpen(true)
  }

  const categoryOptions = useMemo(() => categories, [categories])
  const categoryNames = useMemo(() => categories.map((category) => category.name), [categories])

  return (
    <main className="min-h-[calc(100vh-64px)] bg-slate-100 px-4 py-8 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-[1700px] space-y-6">
        <header>
          <h1 className="text-4xl font-bold text-slate-900">Inventory</h1>
          <p className="mt-1 text-lg text-slate-600">View stock and manage items by category.</p>
        </header>

        <section className="rounded-xl border bg-white p-6 shadow-sm space-y-4">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
            <input
              type="text"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
                placeholder="Search by item name or category"
              className="w-full rounded-lg border border-slate-300 px-4 py-2.5 text-sm text-slate-900 outline-none transition focus:border-slate-500 md:col-span-2"
            />
            <select
              value={categoryFilter}
              onChange={(event) => setCategoryFilter(event.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-slate-500"
            >
              <option value="all">All Categories</option>
              {categoryNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <select
              value={conditionFilter}
              onChange={(event) => setConditionFilter(event.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-slate-500"
            >
              <option value="all">All Conditions</option>
              <option value="New">New</option>
              <option value="Refurbished">Refurbished</option>
            </select>
            <select
              value={stockStatusFilter}
              onChange={(event) => setStockStatusFilter(event.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-slate-500"
            >
              <option value="all">All</option>
              <option value="Available">Available</option>
              <option value="Low Stock">Low Stock</option>
              <option value="Out of Stock">Out of Stock</option>
            </select>
            <div className="grid grid-cols-2 gap-2 xl:col-span-2">
              <input
                type="number"
                min={0}
                value={minPrice}
                onChange={(event) => setMinPrice(event.target.value)}
                placeholder="Min price"
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-slate-500"
              />
              <input
                type="number"
                min={0}
                value={maxPrice}
                onChange={(event) => setMaxPrice(event.target.value)}
                placeholder="Max price"
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-slate-500"
              />
            </div>
          </div>

          {isAdmin && (
            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={() => setIsCategoryModalOpen(true)}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-900 transition hover:bg-slate-50"
              >
                <Tags className="h-4 w-4" />
                Manage Categories
              </button>
              <button
                onClick={() => {
                  setEditingProduct(null)
                  setIsProductModalOpen(true)
                }}
                className="inline-flex items-center gap-2 rounded-lg bg-sky-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-800"
              >
                <Plus className="h-4 w-4" />
                Add Inventory Item
              </button>
              <Link
                href="/inventory/trash"
                className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-900 transition hover:bg-slate-50"
              >
                <Trash2 className="h-4 w-4" />
                View Trash
              </Link>
            </div>
          )}
          {error && <p className="text-sm text-red-600">{error}</p>}
        </section>

        <section className="rounded-xl border bg-white p-6 shadow-sm">
          <h2 className="mb-4 text-2xl font-semibold text-slate-900">Inventory List</h2>
          <ProductTable
            products={filteredProducts}
            canManage={isAdmin}
            onEdit={openEditModal}
            onDelete={handleDeleteProduct}
            deletingProductId={deletingProductId}
            loading={loading}
          />
        </section>
      </div>

      <ProductModal
        isOpen={isProductModalOpen}
        onClose={() => {
          setIsProductModalOpen(false)
          setEditingProduct(null)
        }}
        onSubmit={handleSaveProduct}
        categories={categoryOptions}
        initialValues={
          editingProduct
            ? {
                name: editingProduct.name,
                categoryId: editingProduct.categoryId,
                price: editingProduct.price,
                quantity: editingProduct.quantity,
                minStock: editingProduct.minStock,
                condition: editingProduct.condition,
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
    </main>
  )
}
