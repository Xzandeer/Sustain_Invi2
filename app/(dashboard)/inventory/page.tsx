'use client'

// Inventory page - the item list, with add, edit, stock adjustment and voiding.
//
// Every item is stocked as New or Refurbished. In surplus retail the same
// product sells at a different price depending on condition, so the two are
// tracked as separate variants rather than one item with a note.
//
// Table behaviour the user controls:
//   • Sorting        - 9 options; 'recent' is the default so newly added items
//                      appear at the top, which is how staff actually work
//   • Column visibility - toggled from the Table Options menu (the burger icon)
// Both are saved to localStorage under 'sustain.inventory.tablePrefs.v3', so each
// person's layout survives a refresh.
//
// Actions are permission-gated: canManageInventory for add/edit/adjust,
// canVoidItems for voiding. Staff without a permission never see the button.

import { INPUT_LIMITS } from '@/lib/constants/limits'
import Link from 'next/link'
import { apiFetch } from '@/lib/apiFetch'
import { Fragment, Suspense, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { collection, onSnapshot } from 'firebase/firestore'
import { Plus, Tags, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { auth, db } from '@/lib/firebase'
import ProtectedRoute from '@/components/shared/ProtectedRoute'
import { useConfirm } from '@/components/shared/ConfirmDialog'
import ProductModal, { ProductFormValues } from '@/components/inventory/ProductModal'
import { saveProduct } from '@/lib/inventory/saveProduct'
import StockAdjustmentModal, { type StockAdjustmentValues } from '@/components/inventory/StockAdjustmentModal'
import UnitsPanel from '@/components/inventory/UnitsPanel'
import ReceiveStockModal, { type ReceiveTarget } from '@/components/inventory/ReceiveStockModal'
import { GRADE_LABEL, GRADE_MEANING, GRADE_TONE, UNIT_GRADES, gradeSummary, type UnitGrade } from '@/lib/inventory/units'
import type { TrackingMode } from '@/lib/inventory/units'
import CategoryModal from '@/components/categories/CategoryModal'
import { useUserRole } from '@/hooks/useUserRole'
import { getStockStatus, normalizeInventoryCondition } from '@/lib/server/salesInventoryMetrics'
import { openLabelPrintWindow, openUnitLabelsPrintWindow } from '@/lib/transactions/labelPrint'

// Shape of an inventory row as this page holds it. Lived in a ProductTable
// component that was never rendered - the table below is inline - so the type
// moved here with it.
export interface Product {
  id: string
  categoryId: string
  name: string
  category: string
  price: number
  quantity: number
  reservedStock: number
  availableStock: number
  minStock: number
  condition: 'New' | 'Refurbished'
  description?: string
  imageUrl?: string
  stockStatus: 'Available' | 'Low Stock' | 'Out of Stock'
  isDeleted?: boolean
  isVoided?: boolean
  voidedAt?: string | null
  voidedBy?: string | null
  voidReason?: string | null
  // Total units written off this item. Present even when isVoided is false,
  // because a partial void leaves the item active but still records the loss.
  voidedUnits?: number | null
  // Short scannable code, one per variant. Assigned on creation; older items
  // get one from the Assign Barcodes action.
  barcode?: string | null
  isSingleItem?: boolean
  conditionNotes?: string
  /** 'unit' when every piece has its own record - see lib/inventory/units.ts. */
  trackingMode?: TrackingMode
  createdAtMs?: number
}

interface Category {
  id: string
  name: string
}

type SortOption =
  | 'recent' | 'oldest'
  | 'name' | 'name_desc'
  | 'price_low' | 'price_high'
  | 'stock_low' | 'stock_high'
  | 'category' | 'category_desc'
  | 'shelf_long' | 'shelf_short'

/** A piece older than this on the shelf counts as slow-moving. */
const STALE_DAYS = 60

type TypeFilter = 'all' | 'unit' | 'qty' | 'single'

const SORT_OPTIONS: { value: SortOption; label: string }[] = [
  { value: 'recent',     label: 'Recently Added' },
  { value: 'oldest',     label: 'Oldest First' },
  { value: 'name',       label: 'Name (A\u2013Z)' },
  { value: 'name_desc',  label: 'Name (Z\u2013A)' },
  { value: 'price_low',  label: 'Price (Low to High)' },
  { value: 'price_high', label: 'Price (High to Low)' },
  { value: 'stock_low',  label: 'Stock (Low to High)' },
  { value: 'stock_high', label: 'Stock (High to Low)' },
  { value: 'category',   label: 'Category (A\u2013Z)' },
  { value: 'shelf_long', label: 'Longest on the shelf' },
  { value: 'shelf_short', label: 'Newest on the shelf' },
]

type ColumnKey = 'category' | 'price' | 'stock' | 'reserved' | 'available' | 'condition' | 'status' | 'barcode'

const COLUMN_LABELS: { key: ColumnKey; label: string }[] = [
  { key: 'category',  label: 'Category' },
  { key: 'price',     label: 'Price' },
  { key: 'stock',     label: 'Stock' },
  { key: 'reserved',  label: 'Reserved' },
  { key: 'available', label: 'Available' },
  { key: 'condition', label: 'Condition' },
  { key: 'status',    label: 'Stock Status' },
  { key: 'barcode',   label: 'Barcode' },
]

// Every column is shown until the user hides it from Table Options. Their
// choice is saved in this browser and restored on the next visit.
const DEFAULT_COLUMNS: Record<ColumnKey, boolean> = {
  category: true, price: true, stock: true,
  reserved: true, available: true, condition: true, status: true,
  barcode: true,
}

const TABLE_PREFS_KEY = 'sustain.inventory.tablePrefs.v3'

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
      {/* useSearchParams needs a Suspense boundary during prerender */}
      <Suspense fallback={null}>
        <InventoryContent />
      </Suspense>
    </ProtectedRoute>
  )
}

function InventoryContent() {
  const { isAdmin, can } = useUserRole()
  // The app's own confirm window, as on Reservations.
  const { confirm, confirmDialog } = useConfirm()
  const canManageInventory = isAdmin || can('canManageInventory')
  const canVoid = isAdmin || can('canVoidItems')
  const [inventory, setInventory] = useState<Product[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [conditionFilter, setConditionFilter] = useState('all')
  // ?status=Low%20Stock lets the dashboard cards open the list already filtered
  const searchParams = useSearchParams()
  const initialStatus = (() => {
    const raw = searchParams.get('status')
    return raw === 'Low Stock' || raw === 'Out of Stock' || raw === 'Available' ? raw : 'all'
  })()
  const [stockStatusFilter, setStockStatusFilter] = useState(initialStatus)
  // unit = tracked per piece; qty = counted only; single = one-off pieces.
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  const [staleOnly, setStaleOnly] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [rowMenuId, setRowMenuId] = useState<string | null>(null)
  // Esc closes the More menu and a row's ⋯ menu.
  useEffect(() => {
    if (!moreOpen && !rowMenuId) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setMoreOpen(false); setRowMenuId(null) } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [moreOpen, rowMenuId])
  const [reservedOnly, setReservedOnly] = useState(false)
  const [minPrice, setMinPrice] = useState('')
  const [maxPrice, setMaxPrice] = useState('')
  const [sortBy, setSortBy] = useState<SortOption>('recent')
  const [showTableOptions, setShowTableOptions] = useState(false)
  const [visibleColumns, setVisibleColumns] = useState<Record<ColumnKey, boolean>>(DEFAULT_COLUMNS)

  // Restore the user's saved table preferences.
  //
  // `prefsLoaded` stops the save effect below from running before this one
  // has read the stored value. Without it the first render's defaults are
  // written straight over the user's saved choices (React runs both effects
  // on mount, and twice in development), so hidden columns came back.
  const [prefsLoaded, setPrefsLoaded] = useState(false)
  useEffect(() => {
    try {
      const raw = localStorage.getItem(TABLE_PREFS_KEY)
      if (!raw) return
      const saved = JSON.parse(raw) as { sortBy?: SortOption; columns?: Record<string, boolean> }
      if (saved.sortBy) setSortBy(saved.sortBy)
      if (saved.columns) {
        // Keep only known columns with boolean values. Preferences saved by an
        // older build may be missing newer columns or carry ones since removed;
        // merging blindly would leave gaps in the object.
        const clean: Partial<Record<ColumnKey, boolean>> = {}
        for (const { key } of COLUMN_LABELS) {
          const value = saved.columns[key]
          if (typeof value === 'boolean') clean[key] = value
        }
        setVisibleColumns(prev => ({ ...prev, ...clean }))
      }
    } catch { /* ignore malformed preferences */ }
    finally { setPrefsLoaded(true) }
  }, [])

  // Persist whenever they change - but only once the saved value has been read.
  useEffect(() => {
    if (!prefsLoaded) return
    try {
      localStorage.setItem(TABLE_PREFS_KEY,
        JSON.stringify({ sortBy, columns: visibleColumns }))
    } catch { /* storage unavailable */ }
  }, [prefsLoaded, sortBy, visibleColumns])

  const [isProductModalOpen, setIsProductModalOpen] = useState(false)
  const [isCategoryModalOpen, setIsCategoryModalOpen] = useState(false)
  const [isAdjustmentModalOpen, setIsAdjustmentModalOpen] = useState(false)
  const [editingProduct, setEditingProduct] = useState<Product | null>(null)
  const [adjustingProduct, setAdjustingProduct] = useState<Product | null>(null)
  // Item whose pieces are shown under its row.
  const [unitsProduct, setUnitsProduct] = useState<Product | null>(null)
  // Receive stock: open, and the item it adds to (null = a new or typed item).
  const [receiveOpen, setReceiveOpen] = useState(false)
  const [receiveTarget, setReceiveTarget] = useState<ReceiveTarget | null>(null)
  // Pieces on the shelf per item and condition (/api/inventory/units/summary).
  const [shelf, setShelf] = useState<Record<string, { grades: Array<{ grade: UnitGrade; count: number; price: number }>; ownPriced: Array<{ grade: UnitGrade; count: number; minPrice?: number; maxPrice?: number }>; reserved?: number; oldestDays: number | null }>>({})

  const [savingProduct, setSavingProduct] = useState(false)
  const [adjustingStock, setAdjustingStock] = useState(false)
  const [deletingProductId, setDeletingProductId] = useState<string | null>(null)
  const [deletingCategoryId, setDeletingCategoryId] = useState<string | null>(null)
  const [addingCategory, setAddingCategory] = useState(false)
  const [voidTab, setVoidTab] = useState<'active' | 'voided' | 'all'>('active')
  const [voidingProduct, setVoidingProduct] = useState<Product | null>(null)
  const [voidingId, setVoidingId] = useState<string | null>(null)
  // Item currently being restored, plus how many of its voided units to bring
  // back. Restoring is not all-or-nothing: some of a damaged batch may be fine.
  const [restoringProduct, setRestoringProduct] = useState<Product | null>(null)
  const [restoreQty, setRestoreQty] = useState(0)

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
              voidedUnits: typeof data.voidedUnits === 'number' ? data.voidedUnits : null,
              barcode: typeof data.barcode === 'string' ? data.barcode : null,
              isSingleItem: data.isSingleItem === true,
              conditionNotes: typeof data.conditionNotes === 'string' ? data.conditionNotes.trim() : '',
              trackingMode: (data.trackingMode === 'unit' ? 'unit' : 'quantity') as TrackingMode,
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

    return () => {
      unsubscribeCategories()
      unsubscribeInventory()
    }
  }, [])

  const filteredProducts = useMemo(() => {
    const searchTerm = search.trim().toLowerCase()
    const minPriceValue = minPrice ? Number(minPrice) : null
    const maxPriceValue = maxPrice ? Number(maxPrice) : null

    const tabFiltered = inventory.filter((product) => {
      // Active  = anything still sellable, including items that had SOME units
      //           written off but still have stock left.
      // Voided  = every item with a write-off on record, whether it was voided
      //           entirely or only in part. A partially voided item therefore
      //           appears under both tabs, which is correct: it is still on sale
      //           and it still has units that were written off.
      if (voidTab === 'active') return !product.isVoided
      if (voidTab === 'voided') return product.isVoided === true || (product.voidedUnits ?? 0) > 0
      return true // 'all'
    })
    return tabFiltered
      .filter((product) => {
        if (!searchTerm) return true
        return (
          product.name.toLowerCase().includes(searchTerm) ||
          product.category.toLowerCase().includes(searchTerm) ||
          (product.barcode ?? '').toLowerCase().includes(searchTerm) ||
          (product.conditionNotes ?? '').toLowerCase().includes(searchTerm)
        )
      })
      .filter((product) => (categoryFilter === 'all' ? true : product.category === categoryFilter))
      // Condition: items holding at least one piece in it on the shelf; "mixed"
      // = pieces in two or more conditions. Counted-only items have one
      // condition (New, or Good for older Refurbished stock).
      .filter((product) => {
        if (conditionFilter === 'all') return true
        const held = product.trackingMode === 'unit'
          ? new Set([...(shelf[product.id]?.grades ?? []), ...(shelf[product.id]?.ownPriced ?? [])].map((g) => g.grade as string))
          : new Set([product.condition === 'Refurbished' ? 'Good' : 'New'])
        return held.has(conditionFilter)
      })
      .filter((product) => (stockStatusFilter === 'all' ? true : product.stockStatus === stockStatusFilter))
      .filter((product) =>
        typeFilter === 'all' ? true
        : typeFilter === 'single' ? product.isSingleItem === true
        : typeFilter === 'unit' ? product.trackingMode === 'unit' && product.isSingleItem !== true
        : product.trackingMode !== 'unit' && product.isSingleItem !== true
      )
      .filter((product) => (staleOnly ? (shelf[product.id]?.oldestDays ?? 0) > STALE_DAYS : true))
      .filter((product) => (reservedOnly ? product.reservedStock > 0 : true))
      .filter((product) =>
        minPriceValue == null || Number.isNaN(minPriceValue) ? true : product.price >= minPriceValue
      )
      .filter((product) =>
        maxPriceValue == null || Number.isNaN(maxPriceValue) ? true : product.price <= maxPriceValue
      )
      .sort((a, b) => {
        // What an item sells for: its cheapest / dearest condition on the shelf.
        const prices = (p: Product) => {
          const sh = p.trackingMode === 'unit' ? shelf[p.id] : undefined
          const list = sh ? [...sh.grades.map((g) => g.price), ...sh.ownPriced.flatMap((g) => [g.minPrice ?? 0, g.maxPrice ?? 0]).filter((n) => n > 0)] : []
          return list.length ? list : [p.price]
        }
        const waited = (p: Product) => shelf[p.id]?.oldestDays ?? -1
        switch (sortBy) {
          case 'recent':     return (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0)
          case 'oldest':     return (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0)
          case 'name':       return a.name.localeCompare(b.name)
          case 'name_desc':  return b.name.localeCompare(a.name)
          case 'price_low':  return Math.min(...prices(a)) - Math.min(...prices(b))
          case 'price_high': return Math.max(...prices(b)) - Math.max(...prices(a))
          case 'shelf_long':  return waited(b) - waited(a)
          case 'shelf_short': return waited(a) - waited(b)
          case 'stock_low':  return a.quantity - b.quantity
          case 'stock_high': return b.quantity - a.quantity
          case 'category':      return a.category.localeCompare(b.category) || a.name.localeCompare(b.name)
          case 'category_desc': return b.category.localeCompare(a.category) || a.name.localeCompare(b.name)
          default:           return 0
        }
      })
  }, [inventory, shelf, search, categoryFilter, conditionFilter, stockStatusFilter, typeFilter, reservedOnly, staleOnly, minPrice, maxPrice, voidTab, sortBy])

  const handleSaveProduct = async (values: ProductFormValues) => {
    setError('')
    setSavingProduct(true)
    try {
      // Same request the dashboard's Add Item quick action sends.
      await saveProduct(values, categories, editingProduct?.id)

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

  const handleDeleteProduct = async (productId: string, productName: string) => {
    if (!isAdmin) return
    // It used to go straight to the Trash on one click.
    if (!(await confirm({
      title: 'Move to the Trash?',
      message: <><span className="font-medium text-slate-800">{productName}</span> leaves the Inventory list. You can restore it from the Trash; its history is kept.</>,
      confirmLabel: 'Move to Trash',
      tone: 'danger',
    }))) return
    setError('')
    setDeletingProductId(productId)
    try {
      const response = await apiFetch(`/api/inventory/${productId}`, {
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

  const handleVoidProduct = async (productId: string, voidReason: string, voidQuantity: number, unitIds: string[] = []) => {
    if (!isAdmin) return
    setError('')
    setVoidingId(productId)
    try {
      const response = await apiFetch(`/api/inventory/${productId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'void',
          voidReason,
          voidQuantity,
          ...(unitIds.length > 0 ? { unitIds } : {}),
          processedBy: {
            uid: auth.currentUser?.uid ?? '',
            email: auth.currentUser?.email ?? '',
            name: auth.currentUser?.displayName ?? auth.currentUser?.email ?? '',
          },
        }),
      })
      const payload = (await response.json()) as { error?: string; isFullVoid?: boolean; newStock?: number }
      if (!response.ok) throw new Error(payload.error || 'Failed to void item.')
      toast.success(payload.isFullVoid ? 'Item fully written off.' : `${voidQuantity} unit${voidQuantity !== 1 ? 's' : ''} written off — stock updated.`)
      setVoidingProduct(null)
    } catch (voidError) {
      const message = voidError instanceof Error ? voidError.message : 'Failed to void item.'
      setError(message)
      toast.error(message)
    } finally {
      setVoidingId(null)
    }
  }

  // Opens the restore dialog, defaulting to bringing every voided unit back.
  const openRestoreModal = (product: Product) => {
    setRestoreQty(product.voidedUnits ?? 0)
    setRestoringProduct(product)
  }

  const handleUnvoidProduct = async (productId: string, restoreQuantity: number) => {
    if (!isAdmin) return
    setError('')
    setVoidingId(productId)
    try {
      const response = await apiFetch(`/api/inventory/${productId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'unvoid',
          restoreQuantity,
          processedBy: {
            uid: auth.currentUser?.uid ?? '',
            email: auth.currentUser?.email ?? '',
            name: auth.currentUser?.displayName ?? auth.currentUser?.email ?? '',
          },
        }),
      })
      const payload = (await response.json()) as {
        error?: string
        restoreQuantity?: number
        remainingVoidedUnits?: number
      }
      if (!response.ok) throw new Error(payload.error || 'Failed to restore item.')
      const back = payload.restoreQuantity ?? restoreQuantity
      const left = payload.remainingVoidedUnits ?? 0
      toast.success(
        back > 0
          ? `${back} unit${back !== 1 ? 's' : ''} restored.` +
              (left > 0 ? ` ${left} still voided.` : '')
          : 'Item restored.'
      )
      setRestoringProduct(null)
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
      const response = await apiFetch('/api/categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          requestedByUid: auth.currentUser?.uid ?? '',
        }),
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
      const response = await apiFetch(`/api/categories/${categoryId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestedByUid: auth.currentUser?.uid ?? '' }),
      })
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

  const handleAdjustStock = async (values: StockAdjustmentValues) => {
    if (!adjustingProduct) return

    setAdjustingStock(true)
    setError('')
    try {
      const response = await apiFetch(`/api/inventory/${adjustingProduct.id}/adjust`, {
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

      const payload = (await response.json()) as {
        error?: string
        units?: Array<{ unitCode: string; grade: string }>
      }
      if (!response.ok) {
        throw new Error(payload.error || 'Failed to adjust stock.')
      }

      // New pieces each have their own code: offer their labels straight away.
      const newUnits = payload.units ?? []
      if (newUnits.length > 0) {
        const p = adjustingProduct
        toast.success(`${newUnits.length} new piece${newUnits.length === 1 ? '' : 's'} added with their own codes.`, {
          action: {
            label: 'Print labels',
            onClick: () => openUnitLabelsPrintWindow(
              { name: p.name, price: p.price, condition: p.condition, categoryName: p.category },
              newUnits.map((u) => ({ unitCode: u.unitCode, grade: u.grade, price: values.unitPrice ?? null })),
            ),
          },
        })
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

  // Pieces per condition, re-read whenever the inventory changes.
  //
  // A failed read used to be swallowed: every per-piece item then showed
  // "None on the shelf" and "Not tracked per piece" beside "9 in the shop",
  // which reads as lost stock. Now it retries once, and says so if it still
  // cannot load.
  const [shelfState, setShelfState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [shelfRetry, setShelfRetry] = useState(0)
  // The server's reason, e.g. the Firebase free-plan daily read limit.
  const [shelfError, setShelfError] = useState('')
  useEffect(() => {
    if (!inventory.some((p) => p.trackingMode === 'unit')) return
    let cancelled = false
    const load = () => apiFetch('/api/inventory/units/summary')
      .then(async (r) => {
        if (r.ok) return r.json()
        const body = (await r.json().catch(() => ({}))) as { error?: string }
        // 401/403 (signed out, no access, daily limit) will not pass on a retry.
        throw Object.assign(new Error(body.error || `The server answered ${r.status}.`), { final: r.status === 401 || r.status === 403 })
      })
      .then((d: { items?: typeof shelf }) => { if (!d?.items) throw new Error('empty'); return d.items })
    const t = setTimeout(() => {
      load()
        .catch((err: { final?: boolean }) => err?.final
          ? Promise.reject(err)
          : new Promise<typeof shelf>((res, rej) => setTimeout(() => load().then(res, rej), 2000)))
        .then((items) => { if (!cancelled) { setShelf(items); setShelfState('ready') } })
        .catch((err: unknown) => {
          if (cancelled) return
          setShelfError(err instanceof Error ? err.message : '')
          setShelfState((cur) => (cur === 'ready' ? cur : 'error'))
        })
    }, 250)
    return () => { cancelled = true; clearTimeout(t) }
  }, [inventory, shelfRetry])
  // Unique names: the filter matches by name, so two category documents with
  // the same name must appear once (and would otherwise break React keys).
  const categoryNames = useMemo(
    () => Array.from(new Set(categories.map((category) => category.name))),
    [categories]
  )


  // ── Pagination state ──────────────────────────────
  const [currentPage, setCurrentPage] = useState(1)
  const [itemsPerPage, setItemsPerPage] = useState(10)

  // Reset to page 1 when filters change
  useEffect(() => { setCurrentPage(1) }, [search, categoryFilter, conditionFilter, stockStatusFilter, typeFilter, reservedOnly, staleOnly, voidTab, minPrice, maxPrice])

  const totalPages = Math.max(1, Math.ceil(filteredProducts.length / itemsPerPage))
  const paginatedProducts = useMemo(
    () => filteredProducts.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage),
    [filteredProducts, currentPage, itemsPerPage]
  )

  // ── KPI cards ─────────────────────────────────────
  //
  // Counted from NON-VOIDED items only. A voided item cannot be sold or
  // reserved - both /api/sales and /api/reservations reject it - so counting it
  // under "Ready for sale" would state something the system itself refuses to
  // do. The voided records still exist; they are just not sellable stock.
  //
  // The Voided tab has its own count below, so nothing is hidden.
  // Click-to-sort column headers.
  //
  // Each sortable column owns an ascending/descending pair of SortOption values.
  // Clicking cycles asc -> desc -> asc; clicking a different column starts at
  // ascending. The dropdown still works and stays in sync, since both write to
  // the same `sortBy` state.
  const SORT_PAIRS: Partial<Record<ColumnKey | 'name' | 'shelf', [SortOption, SortOption]>> = {
    name:     ['name', 'name_desc'],
    category: ['category', 'category_desc'],
    price:    ['price_high', 'price_low'],
    stock:    ['stock_low', 'stock_high'],
    shelf:    ['shelf_long', 'shelf_short'],
  }

  const toggleSort = (col: keyof typeof SORT_PAIRS) => {
    const pair = SORT_PAIRS[col]
    if (!pair) return
    setSortBy(sortBy === pair[0] ? pair[1] : pair[0])
    setCurrentPage(1)
  }

  /** A column heading that sorts by its column; the arrow shows the direction. */
  const sortHead = (label: string, col: keyof typeof SORT_PAIRS, align: 'left' | 'right' = 'left') => {
    const pair = SORT_PAIRS[col]
    const on = !!pair && (sortBy === pair[0] || sortBy === pair[1])
    const second = !!pair && sortBy === pair[1]
    return (
      <th className={align === 'right' ? 'px-3 py-2.5 text-right' : 'px-3 py-2.5 text-left'} aria-sort={on ? (second ? 'descending' : 'ascending') : 'none'}>
        <button type="button" onClick={() => toggleSort(col)} title={`Sort by ${label.toLowerCase()}`}
          className={`inline-flex items-center gap-1 uppercase tracking-wide transition-colors hover:text-slate-800 ${on ? 'text-blue-600' : ''}`}>
          {label}
          <svg aria-hidden className={`h-3 w-3 ${on ? '' : 'text-slate-300'} ${second ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      </th>
    )
  }

  // '' = not sorted by this column, 'asc' / 'desc' = current direction
  const sortDir = (col: keyof typeof SORT_PAIRS): '' | 'asc' | 'desc' => {
    const pair = SORT_PAIRS[col]
    if (!pair) return ''
    return sortBy === pair[0] ? 'asc' : sortBy === pair[1] ? 'desc' : ''
  }

  // Assigns barcodes to stock encoded before barcoding existed.
  //
  // Items created from now on get one automatically. Safe to run repeatedly -
  // the endpoint skips anything that already carries a code, so a label already
  // stuck to a physical item never becomes wrong.
  const [assigningBarcodes, setAssigningBarcodes] = useState(false)
  const handleAssignBarcodes = async () => {
    if (!isAdmin || assigningBarcodes) return
    setAssigningBarcodes(true)
    try {
      const res = await apiFetch('/api/inventory/barcodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          processedBy: {
            uid: auth.currentUser?.uid ?? '',
            email: auth.currentUser?.email ?? '',
            name: auth.currentUser?.displayName ?? auth.currentUser?.email ?? '',
          },
        }),
      })
      const payload = (await res.json()) as { assigned?: number; alreadyHadCode?: number; error?: string }
      if (!res.ok) throw new Error(payload.error || 'Failed to assign barcodes.')
      toast.success(
        payload.assigned
          ? `${payload.assigned} barcode${payload.assigned === 1 ? '' : 's'} assigned.`
          : 'Every item already has a barcode.'
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to assign barcodes.')
    } finally {
      setAssigningBarcodes(false)
    }
  }


  const sellableInventory = useMemo(() => inventory.filter((p) => !p.isVoided), [inventory])
  // Older data can hold counted-only items; new items are always per piece.
  const hasCountedItems = useMemo(() => inventory.some((p) => p.trackingMode !== 'unit'), [inventory])

  const kpiTotal        = sellableInventory.length
  const kpiAvailable    = sellableInventory.filter((p) => p.stockStatus === 'Available').length
  const kpiReserved     = sellableInventory.filter((p) => p.reservedStock > 0).length
  const kpiLowStock     = sellableInventory.filter((p) => p.stockStatus === 'Low Stock').length
  const kpiOutOfStock   = sellableInventory.filter((p) => p.stockStatus === 'Out of Stock').length
  const kpiVoided       = inventory.filter((p) => p.isVoided).length
  const kpiSingle       = sellableInventory.filter((p) => p.isSingleItem).length
  const kpiWrittenOff   = inventory.filter((p) => p.isVoided || (p.voidedUnits ?? 0) > 0).length

  const hasActiveFilters =
    search.trim() !== '' || categoryFilter !== 'all' || conditionFilter !== 'all' ||
    stockStatusFilter !== 'all' || typeFilter !== 'all' || reservedOnly || staleOnly ||
    minPrice !== '' || maxPrice !== ''

  const clearFilters = () => {
    setSearch(''); setCategoryFilter('all'); setConditionFilter('all')
    setStockStatusFilter('all'); setTypeFilter('all'); setReservedOnly(false); setStaleOnly(false)
    setMinPrice(''); setMaxPrice('')
  }

  // The summary cards double as one-click filters. Clicking the active card
  // again clears it.
  type QuickKey = 'all' | 'available' | 'low' | 'out' | 'reserved' | 'single' | 'stale'
  const activeQuick: QuickKey =
    staleOnly ? 'stale'
    : reservedOnly ? 'reserved'
    : typeFilter === 'single' ? 'single'
    : stockStatusFilter === 'Available' ? 'available'
    : stockStatusFilter === 'Low Stock' ? 'low'
    : stockStatusFilter === 'Out of Stock' ? 'out'
    : 'all'
  const applyQuick = (key: QuickKey) => {
    const next = key === activeQuick ? 'all' : key
    setVoidTab('active')
    setStockStatusFilter(
      next === 'available' ? 'Available' : next === 'low' ? 'Low Stock' : next === 'out' ? 'Out of Stock' : 'all'
    )
    setReservedOnly(next === 'reserved')
    setTypeFilter(next === 'single' ? 'single' : 'all')
    setStaleOnly(next === 'stale')
  }

  // ── Export CSV ────────────────────────────────────
  const exportCSV = () => {
    // Quote any field containing a comma, quote or newline so columns stay aligned
    const esc = (v: unknown) => {
      const str = String(v ?? '')
      return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str
    }
    // Condition and price as the list shows them. The item's own fields are
    // its old New/Refurbished label and base price, so every per-piece item
    // exported as "Refurbished" at one price.
    const conditionOf = (p: Product) => {
      if (p.trackingMode !== 'unit') return p.condition === 'Refurbished' ? 'Good' : 'New'
      const counts = conditionCounts(p)
      return UNIT_GRADES.filter((g) => counts.has(g)).map((g) => (counts.get(g)! > 1 ? `${g} ×${counts.get(g)}` : g)).join(', ')
    }
    const priceOf = (p: Product) => {
      const sh = p.trackingMode === 'unit' ? shelf[p.id] : undefined
      const prices = sh ? [...sh.grades.map((g) => g.price), ...sh.ownPriced.flatMap((g) => [g.minPrice ?? 0, g.maxPrice ?? 0]).filter((n) => n > 0)] : []
      if (prices.length === 0) return p.price.toFixed(2)
      const lo = Math.min(...prices), hi = Math.max(...prices)
      return lo === hi ? lo.toFixed(2) : `${lo.toFixed(2)} - ${hi.toFixed(2)}`
    }
    const headers = ['Item Name', 'Category', 'Condition', 'Price', 'Stock', 'Reserved', 'Available', 'Min Stock', 'Status']
    const rows = filteredProducts.map((p) => [
      p.name, p.category, conditionOf(p),
      priceOf(p), p.quantity, p.reservedStock, p.availableStock, p.minStock, p.stockStatus,
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

  // ── Row helpers ───────────────────────────────────────────────────────────

  /** One label per piece on the shelf (unit-tracked), or copies of the item code. */
  const printLabels = async (product: Product) => {
    if (product.trackingMode === 'unit') {
      try {
        const res = await apiFetch(`/api/inventory/${product.id}/units`)
        const d = (await res.json()) as { data?: Array<{ unitCode: string; grade: string; priceOverride: number | null; status: string }> }
        const onShelf = (d.data ?? []).filter((u) => u.status === 'in_stock' || u.status === 'reserved')
        if (onShelf.length === 0) { toast.error('No pieces in the shop to label.'); return }
        const conditionPrice = new Map((shelf[product.id]?.grades ?? []).map((g) => [g.grade as string, g.price]))
        openUnitLabelsPrintWindow(
          { name: product.name, price: product.price, condition: product.condition, categoryName: product.category },
          onShelf.map((u) => ({ unitCode: u.unitCode, grade: u.grade, price: u.priceOverride ?? conditionPrice.get(u.grade) ?? null })),
        )
      } catch {
        toast.error('Could not load the pieces to label.')
      }
      return
    }
    if (!product.barcode) {
      toast.error('This item has no barcode yet. Use More > Assign barcodes first.')
      return
    }
    // One label per unit in stock - every physical item needs its own.
    openLabelPrintWindow(
      { name: product.name, barcode: product.barcode, price: product.price, condition: product.condition, categoryName: product.category },
      Math.max(1, product.quantity)
    )
  }

  const openAddFor = (product: Product) => {
    setReceiveTarget({ id: product.id, name: product.name, categoryId: product.categoryId, category: product.category, price: product.price, trackingMode: product.trackingMode })
    setReceiveOpen(true)
  }

  /** Pieces per condition on the shelf, for a unit-tracked item. */
  const conditionCounts = (product: Product) => {
    const counts = new Map<UnitGrade, number>()
    const s = shelf[product.id]
    s?.grades.forEach((g) => counts.set(g.grade, (counts.get(g.grade) ?? 0) + g.count))
    s?.ownPriced.forEach((g) => counts.set(g.grade, (counts.get(g.grade) ?? 0) + g.count))
    return counts
  }

  /** Lowest to highest shelf price across conditions, or the item price. */
  const priceText = (product: Product) => {
    const sh = product.trackingMode === 'unit' ? shelf[product.id] : undefined
    const prices = sh ? [...sh.grades.map((g) => g.price), ...sh.ownPriced.flatMap((g) => [g.minPrice ?? 0, g.maxPrice ?? 0]).filter((n) => n > 0)] : []
    if (prices.length === 0) return formatPrice(product.price)
    const lo = Math.min(...prices), hi = Math.max(...prices)
    // Low to high, the way a price range is read.
    return lo === hi ? formatPrice(lo) : `${formatPrice(lo)} – ${formatPrice(hi)}`
  }

  const piecesOnSale = sellableInventory.reduce((sum, p) => sum + p.quantity, 0)
  const piecesReserved = sellableInventory.reduce((sum, p) => sum + Math.min(p.reservedStock, p.quantity), 0)
  // What the stock would sell for: each piece at its own or its condition's
  // price; held pieces at the item's cheapest condition; counted items at
  // their price.
  const shelfValue = sellableInventory.reduce((sum, p) => {
    const sh = p.trackingMode === 'unit' ? shelf[p.id] : undefined
    if (!sh) return sum + p.quantity * p.price
    const priced = sh.grades.reduce((n, g) => n + g.count * g.price, 0)
      + sh.ownPriced.reduce((n, g) => n + g.count * (((g.minPrice ?? 0) + (g.maxPrice ?? 0)) / 2), 0)
    const heldAt = sh.grades.length ? Math.min(...sh.grades.map((g) => g.price)) : p.price
    return sum + priced + (sh.reserved ?? 0) * heldAt
  }, 0)
  const addedText = (ms?: number) => ms ? new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null
  const kpiWaiting = sellableInventory.filter((p) => (shelf[p.id]?.oldestDays ?? 0) > STALE_DAYS).length

  const STATUS_BAND: Array<{ key: QuickKey; label: string; value: number; hint?: string; tone: string }> = [
    { key: 'all', label: 'All items', value: kpiTotal, hint: `${piecesOnSale.toLocaleString('en-PH')} pieces in the shop`, tone: 'text-slate-900' },
    { key: 'available', label: 'Available', value: kpiAvailable, hint: 'above their minimum', tone: 'text-slate-900' },
    { key: 'low', label: 'Low stock', value: kpiLowStock, hint: 'at or below minimum', tone: kpiLowStock > 0 ? 'text-amber-600' : 'text-slate-900' },
    { key: 'out', label: 'Out of stock', value: kpiOutOfStock, hint: 'none left to sell', tone: kpiOutOfStock > 0 ? 'text-red-600' : 'text-slate-900' },
    { key: 'stale', label: `Waiting ${STALE_DAYS}+ days`, value: kpiWaiting, hint: 'oldest piece unsold', tone: 'text-slate-900' },
  ]

  const selectCls = (active: boolean) =>
    `h-8 rounded-lg border bg-white px-2 text-xs focus:outline-none ${active ? 'border-blue-300 text-blue-700' : 'border-slate-200 text-slate-700'}`

  return (
    <div className="flex min-h-[calc(100vh-64px)] flex-col bg-[#F1F5FC] p-3 md:min-h-screen">
      <div className="mx-auto flex min-h-0 w-full max-w-[1500px] flex-1 flex-col gap-2">

        {/* ── Header: the page, its one main action, and the rest under More ── */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">Inventory</h1>
            {!loading && (
              <p className="text-xs text-slate-500">
                <span className="font-semibold tabular-nums text-slate-700">{kpiTotal}</span> items
                <span className="mx-1.5 text-slate-300">·</span>
                <span className="font-semibold tabular-nums text-slate-700">{piecesOnSale.toLocaleString('en-PH')}</span> pieces
                <span className="mx-1.5 text-slate-300">·</span>
                <span className="font-semibold tabular-nums text-slate-700">{formatPrice(shelfValue)}</span> shelf value
                {piecesReserved > 0 && (
                  <>
                    <span className="mx-1.5 text-slate-300">·</span>
                    <span className="font-semibold tabular-nums text-blue-600">{piecesReserved}</span> reserved
                  </>
                )}
              </p>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            {canManageInventory && (
              <button
                onClick={() => setIsCategoryModalOpen(true)}
                className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 transition hover:bg-slate-50"
              >
                Categories
              </button>
            )}
            <div className="relative">
              <button
                onClick={() => setMoreOpen((v) => !v)}
                aria-expanded={moreOpen}
                className="inline-flex h-9 items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 transition hover:bg-slate-50"
              >
                More
                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
              </button>
              {moreOpen && (
                <>
                  <div className="fixed inset-0 z-20" onClick={() => setMoreOpen(false)} />
                  <div className="absolute right-0 z-30 mt-1 w-52 overflow-hidden rounded-lg border border-slate-200 bg-white py-1 text-xs shadow-lg">
                    <button onClick={() => { setMoreOpen(false); exportCSV() }} className="block w-full px-3 py-2 text-left hover:bg-slate-50">Export CSV</button>
                    <button onClick={() => { setMoreOpen(false); setVoidTab(voidTab === 'voided' ? 'active' : 'voided'); setCurrentPage(1) }}
                      className="block w-full px-3 py-2 text-left hover:bg-slate-50">
                      {voidTab === 'voided' ? 'Back to items on sale' : `Written-off items (${kpiWrittenOff})`}
                    </button>
                    {/* Trash is administrator-only (the sidebar hides it too); a
                        staff member following this link was sent straight back. */}
                    {isAdmin && <Link href="/inventory/trash" className="block px-3 py-2 hover:bg-slate-50">Trash</Link>}
                  </div>
                </>
              )}
            </div>
            {canManageInventory && (
              <button
                onClick={() => { setReceiveTarget(null); setReceiveOpen(true) }}
                className="h-9 rounded-lg bg-blue-600 px-3.5 text-xs font-semibold text-white shadow-sm transition hover:bg-blue-700"
              >
                + Add stock
              </button>
            )}
          </div>
        </div>

        {/* ── Status band: figures that double as one-click filters ── */}
        <section className="grid grid-cols-2 divide-slate-200/80 overflow-hidden rounded-xl border border-slate-200/80 bg-white sm:grid-cols-5 sm:divide-x">
          {STATUS_BAND.map((card) => {
            const active = activeQuick === card.key && voidTab === 'active'
            return (
              <button
                key={card.key}
                type="button"
                onClick={() => applyQuick(card.key)}
                aria-pressed={active}
                className={`relative px-4 py-3 text-left transition ${active ? 'bg-blue-50' : 'hover:bg-slate-50'}`}
              >
                <p className={`text-[10px] font-semibold uppercase tracking-wide ${active ? 'text-blue-600' : 'text-slate-500'}`}>{card.label}</p>
                <p className={`mt-0.5 text-2xl font-bold leading-tight tabular-nums ${card.tone}`}>{card.value}</p>
                {card.hint && <p className="truncate text-[11px] text-slate-500">{card.hint}</p>}
                {active && <span aria-hidden className="absolute inset-x-0 bottom-0 h-[3px] bg-blue-600" />}
              </button>
            )
          })}
        </section>

        {shelfState === 'error' && (
          <div role="alert" className="flex items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <span>
              Piece details did not load, so conditions, shelf time and prices by condition are missing below. Stock counts are still correct.
              {shelfError && <span className="mt-0.5 block font-semibold">{shelfError}</span>}
            </span>
            <button type="button" onClick={() => { setShelfState('loading'); setShelfRetry((n) => n + 1) }}
              className="shrink-0 rounded-lg border border-amber-300 bg-white px-2.5 py-1 font-semibold text-amber-800 hover:bg-amber-100">Try again</button>
          </div>
        )}

        {/* ── One filter row ── */}
        <section className="rounded-xl border border-slate-200/80 bg-white p-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="relative flex min-w-[220px] flex-1 items-center">
              <svg className="absolute left-2.5 h-3.5 w-3.5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <circle cx="11" cy="11" r="8" /><path strokeLinecap="round" d="M21 21l-4.35-4.35" />
              </svg>
              <input aria-label="Search items" maxLength={INPUT_LIMITS.search}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name, category, code or notes"
                className="h-8 w-full rounded-lg border border-slate-200 pl-8 pr-7 text-xs text-slate-800 placeholder:text-slate-400 focus:border-blue-400 focus:outline-none"
              />
              {search && (
                <button type="button" onClick={() => setSearch('')} aria-label="Clear search" className="absolute right-1.5 rounded p-0.5 text-slate-500 hover:text-slate-600">
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              )}
            </div>
            <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} aria-label="Category" className={selectCls(categoryFilter !== 'all')}>
              <option value="all">All categories</option>
              {categoryNames.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
            <select value={conditionFilter} onChange={(e) => setConditionFilter(e.target.value)} aria-label="Condition" className={selectCls(conditionFilter !== 'all')}>
              <option value="all">Any condition</option>
              {UNIT_GRADES.map((g) => <option key={g} value={g}>{GRADE_LABEL[g]}</option>)}
            </select>
            {/* Per-piece vs counted is only worth offering when both exist: new
                items are always tracked per piece, so on most data "Counted only"
                was an empty list and "Tracked per piece" was everything. */}
            <select value={reservedOnly ? 'reserved' : typeFilter} onChange={(e) => { const v = e.target.value; setReservedOnly(v === 'reserved'); setTypeFilter(v === 'reserved' ? 'all' : (v as TypeFilter)) }} aria-label="Show items" className={selectCls(typeFilter !== 'all' || reservedOnly)}>
              <option value="all">All items</option>
              {hasCountedItems && <option value="unit">Tracked per piece</option>}
              {hasCountedItems && <option value="qty">Counted only</option>}
              <option value="reserved">With reservations</option>
            </select>
            <select value={sortBy} onChange={(e) => { setSortBy(e.target.value as SortOption); setCurrentPage(1) }} aria-label="Sort by" className={selectCls(false)}>
              {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>Sort: {o.label}</option>)}
            </select>
            <span className="ml-auto flex items-center gap-2 pr-1 text-[11px] text-slate-500">
              {voidTab === 'voided' && <span className="rounded bg-red-50 px-1.5 py-0.5 font-semibold text-red-600">Written off</span>}
              {filteredProducts.length} item{filteredProducts.length === 1 ? '' : 's'}
              {hasActiveFilters && (
                <button type="button" onClick={clearFilters} className="font-semibold text-blue-600 hover:underline">Clear</button>
              )}
            </span>
          </div>
          {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
        </section>

        {/* ── The list ── */}
        <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-200/80 bg-white">
          <div className="min-h-0 flex-1 overflow-auto">
            {loading ? (
              <p className="px-5 py-10 text-center text-sm text-slate-500">Loading items…</p>
            ) : filteredProducts.length === 0 ? (
              <div className="px-5 py-12 text-center">
                <p className="text-sm font-medium text-slate-600">No items match your filters.</p>
                {hasActiveFilters && (
                  <button type="button" onClick={clearFilters} className="mt-2 text-sm font-medium text-blue-600 hover:underline">Clear all filters</button>
                )}
              </div>
            ) : (
              <table className="w-full text-xs">
                <thead className="border-b border-slate-200 bg-slate-50/70 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="w-8 py-2.5 pl-4" />
                    {sortHead('Item', 'name')}
                    <th className="px-3 py-2.5 text-left">{voidTab === 'voided' ? 'Write-off' : 'Pieces by condition'}</th>
                    {sortHead('Price', 'price', 'right')}
                    {sortHead('Stock', 'stock')}
                    {sortHead('On the shelf', 'shelf')}
                    <th className="w-14 py-2.5 pl-3 pr-4" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {paginatedProducts.map((product) => {
                    const expandable = product.trackingMode === 'unit'
                    const isOpen = unitsProduct?.id === product.id
                    const counts = conditionCounts(product)
                    const out = product.availableStock <= 0 && !product.isVoided
                    const low = !out && product.stockStatus === 'Low Stock'
                    const oldest = shelf[product.id]?.oldestDays ?? null
                    return (
                      <Fragment key={product.id}>
                        <tr
                          onClick={() => { if (expandable) setUnitsProduct(isOpen ? null : product) }}
                          className={`${expandable ? 'cursor-pointer' : ''} ${isOpen ? 'bg-blue-50/40' : 'hover:bg-slate-50'} ${
                            product.isVoided ? 'text-slate-500' : out ? 'shadow-[inset_3px_0_0_#ef4444]' : low ? 'shadow-[inset_3px_0_0_#f59e0b]' : ''
                          }`}
                        >
                          <td className="py-3 pl-4 text-slate-500">
                            {expandable && (
                              <svg aria-hidden className={`h-3.5 w-3.5 transition-transform ${isOpen ? 'rotate-90 text-blue-600' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                              </svg>
                            )}
                          </td>
                          <td className="px-3 py-3">
                            <p className="text-[13px] font-semibold text-slate-900">
                              {product.name}
                              {product.isSingleItem && <span className="ml-1.5 rounded bg-blue-50 px-1.5 py-px align-middle text-[10px] font-semibold text-blue-600">One-off</span>}
                              {product.trackingMode !== 'unit' && !product.isSingleItem && <span className="ml-1.5 rounded bg-slate-100 px-1.5 py-px align-middle text-[10px] font-semibold text-slate-500">Counted</span>}
                            </p>
                            <p className="text-[11px] text-slate-500">
                              {product.category}
                              {product.barcode && <><span className="mx-1 text-slate-300">·</span><span className="tabular-nums">Code {product.barcode}</span></>}
                            </p>
                            {product.conditionNotes && (
                              <p className="max-w-[340px] truncate text-[11px] text-slate-500" title={product.conditionNotes}>{product.conditionNotes}</p>
                            )}
                          </td>
                          <td className="px-3 py-3">
                            {voidTab === 'voided' ? (
                              <div>
                                <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${product.isVoided ? 'bg-red-50 text-red-700' : 'bg-orange-50 text-orange-700'}`}>
                                  {product.voidReason || 'No reason recorded'}
                                </span>
                                <p className="mt-1 text-[11px] text-slate-500">
                                  {product.isVoided ? 'Fully written off' : 'Partly written off, still on sale'} · {product.voidedUnits ?? 0} pcs
                                  {product.voidedBy ? ` · by ${product.voidedBy}` : ''}
                                </p>
                              </div>
                            ) : product.trackingMode === 'unit' ? (
                              counts.size === 0 ? (
                                <span className="text-[11px] text-slate-500">
                                  {shelfState === 'ready' ? 'None on the shelf' : shelfState === 'loading' ? 'Loading pieces…' : 'Pieces not loaded'}
                                </span>
                              ) : (
                                // One quiet chip per condition: coloured dot, count, name.
                                <div className="flex flex-wrap gap-1">
                                  {UNIT_GRADES.filter((g) => counts.has(g)).map((g) => (
                                    <span key={g} title={`${GRADE_LABEL[g]}: ${GRADE_MEANING[g]}`} className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-1.5 py-0.5 text-[11px] text-slate-600">
                                      <span className={`h-1.5 w-1.5 rounded-full ${GRADE_TONE[g].dot}`} />
                                      <span className="font-semibold tabular-nums text-slate-900">{counts.get(g)}</span>{g}
                                      {(() => {
                                        const at = shelf[product.id]?.grades.find((x) => x.grade === g)?.price
                                        return at ? <span className="border-l border-slate-200 pl-1.5 font-semibold tabular-nums text-slate-900">{formatPrice(at)}</span> : null
                                      })()}
                                    </span>
                                  ))}
                                </div>
                              )
                            ) : (
                              <span className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-1.5 py-0.5 text-[11px] text-slate-600">
                                <span className={`h-1.5 w-1.5 rounded-full ${product.condition === 'New' ? GRADE_TONE.New.dot : GRADE_TONE.Good.dot}`} />
                                <span className="font-semibold tabular-nums text-slate-900">{product.quantity}</span>{product.condition === 'New' ? 'New' : 'Used'}
                              </span>
                            )}
                          </td>
                          <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums">
                            <p className="text-[13px] font-semibold text-slate-900">{priceText(product)}</p>
                            {product.trackingMode === 'unit' && (shelf[product.id]?.grades.length ?? 0) > 0 && !shelf[product.id]!.grades.some((g) => g.grade === 'New') && (
                              <p className="text-[11px] text-slate-500">{formatPrice(product.price)} each</p>
                            )}
                            {product.trackingMode === 'unit' && (shelf[product.id]?.ownPriced.length ?? 0) > 0 && (
                              <p className="text-[11px] text-slate-500">
                                {shelf[product.id]!.ownPriced.reduce((n, g) => n + g.count, 0)} with own price
                              </p>
                            )}
                          </td>
                          <td className="px-3 py-3">
                            {product.isSingleItem ? (
                              <p className={`font-semibold ${product.availableStock > 0 ? 'text-slate-900' : 'text-red-600'}`}>
                                {product.quantity === 0 ? 'Sold' : product.reservedStock > 0 ? 'On hold' : 'In stock'}
                              </p>
                            ) : (
                              <>
                                <p className="tabular-nums">
                                  <span className={`text-sm font-bold ${out ? 'text-red-600' : low ? 'text-amber-600' : 'text-slate-900'}`}>{product.availableStock}</span>
                                  <span className="text-slate-500"> to sell</span>
                                  {(out || low) && (
                                    <span className={`ml-1.5 rounded px-1.5 py-px text-[10px] font-semibold ${out ? 'bg-red-50 text-red-600' : 'bg-amber-50 text-amber-700'}`}>{out ? 'Out of stock' : 'Low stock'}</span>
                                  )}
                                </p>
                                <p className="text-[11px] tabular-nums text-slate-500">
                                  {product.quantity} in the shop
                                  {product.reservedStock > 0 && <><span className="mx-1 text-slate-300">·</span><span className="text-blue-600">{product.reservedStock} reserved</span></>}
                                  <span className="mx-1 text-slate-300">·</span>min {product.minStock}
                                </p>
                                {(product.voidedUnits ?? 0) > 0 && voidTab !== 'voided' && (
                                  <p className="text-[11px] tabular-nums text-slate-500">{product.voidedUnits} written off</p>
                                )}
                              </>
                            )}
                          </td>
                          <td className="whitespace-nowrap px-3 py-3 tabular-nums">
                            {oldest !== null ? (
                              <p className={oldest > STALE_DAYS ? 'font-semibold text-amber-700' : 'text-slate-700'}>
                                {oldest} day{oldest === 1 ? '' : 's'}
                                <span className="font-normal text-slate-500"> oldest piece</span>
                              </p>
                            ) : (
                              <p className="text-slate-500">
                                {product.trackingMode !== 'unit'
                                  ? (product.quantity > 0 ? 'Not tracked per piece' : 'Nothing on the shelf')
                                  : shelfState !== 'ready' ? '—'
                                  : 'Nothing on the shelf'}
                              </p>
                            )}
                            {addedText(product.createdAtMs) && <p className="text-[11px] text-slate-500">Added {addedText(product.createdAtMs)}</p>}
                          </td>
                          <td className="py-3 pl-3 pr-4 text-right" onClick={(e) => e.stopPropagation()}>
                            <span className="inline-flex items-center gap-1">
                              {(canManageInventory || canVoid) && (
                                <span className="relative">
                                  <button
                                    onClick={() => setRowMenuId(rowMenuId === product.id ? null : product.id)}
                                    aria-label={`More actions for ${product.name}`}
                                    className="h-7 w-7 rounded-lg border border-slate-200 text-slate-500 transition hover:bg-slate-50"
                                  >
                                    ⋯
                                  </button>
                                  {rowMenuId === product.id && (
                                    <>
                                      <div className="fixed inset-0 z-20" onClick={() => setRowMenuId(null)} />
                                      <div className="absolute right-0 z-30 mt-1 w-44 overflow-hidden rounded-lg border border-slate-200 bg-white py-1 text-left text-xs shadow-lg">
                                        {canManageInventory && !product.isVoided && (
                                          <>
                                            {!product.isSingleItem && voidTab !== 'voided' && (
                                              <button onClick={() => { setRowMenuId(null); openAddFor(product) }} className="block w-full px-3 py-2 text-left font-semibold text-blue-600 hover:bg-slate-50">Add more stock</button>
                                            )}
                                            <button onClick={() => { setRowMenuId(null); openEditModal(product) }} className="block w-full px-3 py-2 text-left hover:bg-slate-50">Edit details</button>
                                            {product.trackingMode !== 'unit' && (
                                              <>
                                                <button onClick={() => { setRowMenuId(null); void printLabels(product) }} className="block w-full px-3 py-2 text-left hover:bg-slate-50">Print labels</button>
                                                <button onClick={() => { setRowMenuId(null); openAdjustModal(product) }} className="block w-full px-3 py-2 text-left hover:bg-slate-50">Adjust stock</button>
                                              </>
                                            )}
                                          </>
                                        )}
                                        {canVoid && (product.isVoided || (product.voidedUnits ?? 0) > 0) && (
                                          <button onClick={() => { setRowMenuId(null); openRestoreModal(product) }} disabled={voidingId === product.id}
                                            className="block w-full px-3 py-2 text-left text-emerald-700 hover:bg-slate-50 disabled:opacity-40">
                                            Restore written-off
                                          </button>
                                        )}
                                        {canVoid && !product.isVoided && (
                                          <button onClick={() => { setRowMenuId(null); setVoidingProduct(product) }} disabled={voidingId === product.id}
                                            className="block w-full px-3 py-2 text-left text-red-600 hover:bg-slate-50 disabled:opacity-40">
                                            Write off
                                          </button>
                                        )}
                                        {isAdmin && product.quantity === 0 && product.reservedStock === 0 && (
                                          <button onClick={() => { setRowMenuId(null); void handleDeleteProduct(product.id, product.name) }} disabled={deletingProductId === product.id}
                                            className="block w-full px-3 py-2 text-left text-red-600 hover:bg-slate-50 disabled:opacity-40">
                                            Move to trash
                                          </button>
                                        )}
                                      </div>
                                    </>
                                  )}
                                </span>
                              )}
                            </span>
                          </td>
                        </tr>
                        {/* The item's pieces, opened by clicking its row. */}
                        {isOpen && (
                          <tr>
                            <td colSpan={7} className="bg-blue-50/20 px-3 pb-3 pt-1">
                              <div className="ml-8">
                                <UnitsPanel inline product={product} canEdit={canManageInventory} onClose={() => setUnitsProduct(null)} />
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>

          {/* ── Pagination ── */}
          {filteredProducts.length > 0 && (
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-slate-100 bg-white px-4 py-2 text-[11px] text-slate-500">
              <span className="flex items-center gap-2">
                Showing {(currentPage - 1) * itemsPerPage + 1}–{Math.min(currentPage * itemsPerPage, filteredProducts.length)} of {filteredProducts.length} items
                <select
                  value={itemsPerPage}
                  onChange={(e) => { setItemsPerPage(Number(e.target.value)); setCurrentPage(1) }}
                  aria-label="Items per page"
                  className="rounded-md border border-slate-200 bg-white px-1.5 py-0.5 text-[11px] text-slate-700 focus:outline-none"
                >
                  {[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n} per page</option>)}
                </select>
              </span>
              <span className="flex items-center gap-1">
                <button onClick={() => setCurrentPage((p) => Math.max(1, p - 1))} disabled={currentPage === 1}
                  className="h-7 w-7 rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-40" aria-label="Previous page">‹</button>
                {Array.from({ length: totalPages }, (_, i) => i + 1)
                  .filter((p) => totalPages <= 5 || p === 1 || p === totalPages || Math.abs(p - currentPage) <= 1)
                  .reduce<Array<number | '...'>>((acc, p, i, arr) => {
                    if (i > 0 && typeof arr[i - 1] === 'number' && (p as number) - (arr[i - 1] as number) > 1) acc.push('...')
                    acc.push(p)
                    return acc
                  }, [])
                  .map((item, i) => item === '...' ? (
                    <span key={`e-${i}`} className="w-5 text-center text-slate-500">…</span>
                  ) : (
                    <button key={item} onClick={() => setCurrentPage(item as number)}
                      className={`h-7 w-7 rounded-md text-[11px] font-semibold ${currentPage === item ? 'bg-blue-600 text-white' : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}>
                      {item}
                    </button>
                  ))}
                <button onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages}
                  className="h-7 w-7 rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-40" aria-label="Next page">›</button>
              </span>
            </div>
          )}
        </section>
      </div>

      <ProductModal
        isOpen={isProductModalOpen}
        onClose={() => { setIsProductModalOpen(false); setEditingProduct(null) }}
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
                reservedStock: editingProduct.reservedStock,
                availableStock: editingProduct.availableStock,
                isSingleItem: editingProduct.isSingleItem === true,
                conditionNotes: editingProduct.conditionNotes ?? '',
                trackingMode: editingProduct.trackingMode,
                pieceConditions: gradeSummary([...(shelf[editingProduct.id]?.grades ?? []), ...(shelf[editingProduct.id]?.ownPriced ?? [])]
                  .flatMap((g) => Array<string>(g.count).fill(g.grade))),
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

      <ReceiveStockModal
        isOpen={receiveOpen}
        onClose={() => setReceiveOpen(false)}
        categories={categoryOptions}
        items={inventory.filter((p) => !p.isSingleItem).map((p) => ({
          id: p.id, name: p.name, categoryId: p.categoryId, category: p.category, price: p.price, trackingMode: p.trackingMode,
        }))}
        preset={receiveTarget}
      />

      <StockAdjustmentModal
        isOpen={isAdjustmentModalOpen}
        product={adjustingProduct}
        onClose={() => { setIsAdjustmentModalOpen(false); setAdjustingProduct(null) }}
        onSubmit={handleAdjustStock}
        submitting={adjustingStock}
      />

      {confirmDialog}

      {voidingProduct && (
        <VoidModal
          product={voidingProduct}
          submitting={voidingId === voidingProduct.id}
          onClose={() => setVoidingProduct(null)}
          pieceConditions={gradeSummary(Array.from(conditionCounts(voidingProduct)).flatMap(([g, n]) => Array<UnitGrade>(n).fill(g)))}
          onConfirm={(reason, qty, unitIds) => handleVoidProduct(voidingProduct.id, reason, qty, unitIds)}
        />
      )}

      {/* ── Restore voided units ── */}
      {restoringProduct && (() => {
        const maxRestore = restoringProduct.voidedUnits ?? 0
        const invalid = restoreQty < 1 || restoreQty > maxRestore
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
            <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl">
              <h3 className="text-base font-semibold text-slate-900">Restore voided units</h3>
              <p className="mt-1 text-sm text-slate-500">
                {restoringProduct.name} · {restoringProduct.condition}
              </p>

              <div className="mt-4 rounded-xl bg-slate-50 p-3 text-sm">
                <div className="flex justify-between text-slate-600">
                  <span>Currently in stock</span>
                  <span className="font-semibold text-slate-900">{restoringProduct.quantity}</span>
                </div>
                <div className="mt-1 flex justify-between text-slate-600">
                  <span>Written-off units</span>
                  <span className="font-semibold text-orange-600">{maxRestore}</span>
                </div>
                {restoringProduct.voidReason && (
                  <div className="mt-1 flex justify-between text-slate-600">
                    <span>Reason</span>
                    <span className="font-medium text-slate-700">{restoringProduct.voidReason}</span>
                  </div>
                )}
              </div>

              <label className="mt-4 block text-sm font-medium text-slate-700">
                How many units to restore?
              </label>
              <input
                type="number"
                min={1}
                max={maxRestore}
                value={restoreQty}
                onChange={(e) => setRestoreQty(Math.min(maxRestore, Math.max(1, Math.floor(Number(e.target.value)) || 1)))}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-emerald-400 focus:outline-none"
              />
              <p className="mt-1 text-xs text-slate-500">
                {invalid
                  ? `Enter a number between 1 and ${maxRestore}.`
                  : `Stock will become ${restoringProduct.quantity + restoreQty}` +
                    (maxRestore - restoreQty > 0
                      ? ` · ${maxRestore - restoreQty} will stay written off.`
                      : ' · nothing will stay written off.')}
              </p>

              <div className="mt-5 flex justify-end gap-2">
                <button
                  onClick={() => setRestoringProduct(null)}
                  className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  onClick={() => handleUnvoidProduct(restoringProduct.id, restoreQty)}
                  disabled={invalid || voidingId === restoringProduct.id}
                  className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-40"
                >
                  {voidingId === restoringProduct.id ? 'Restoring…' : 'Restore'}
                </button>
              </div>
            </div>
          </div>
        )
      })()}
    </div>
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
  pieceConditions,
}: {
  product: Product
  submitting: boolean
  onClose: () => void
  onConfirm: (reason: string, quantity: number, unitIds: string[]) => void
  /** "Good ×4, Fair" - the per-piece item's conditions on the shelf. */
  pieceConditions?: string
}) {
  const [reason, setReason] = useState('')
  const [customReason, setCustomReason] = useState('')
  // Pieces held for a customer cannot be written off (the server refuses).
  const sellable = Math.max(0, product.quantity - product.reservedStock)
  const [voidQuantity, setVoidQuantity] = useState(sellable)
  const [localError, setLocalError] = useState('')
  // Per-piece items: the exact pieces to write off - the damaged one, not
  // whichever happens to be oldest on the shelf.
  const perPiece = product.trackingMode === 'unit'
  const [pieces, setPieces] = useState<Array<{ id: string; unitCode: string; grade: string; conditionNotes: string }> | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  useEffect(() => {
    if (!perPiece) return
    let cancelled = false
    apiFetch(`/api/inventory/${product.id}/units?status=in_stock`)
      .then((r) => (r.ok ? r.json() : { data: [] }))
      .then((d: { data?: Array<{ id: string; unitCode: string; grade: string; conditionNotes: string }> }) => { if (!cancelled) setPieces(d.data ?? []) })
      .catch(() => { if (!cancelled) setPieces([]) })
    return () => { cancelled = true }
  }, [perPiece, product.id])
  const count = perPiece ? picked.size : voidQuantity

  const effectiveReason = reason === 'Other' ? customReason.trim() : reason

  const handleSubmit = () => {
    if (!reason) { setLocalError('Please select a reason.'); return }
    if (reason === 'Other' && !customReason.trim()) { setLocalError('Please describe the reason.'); return }
    if (perPiece) {
      if (picked.size === 0) { setLocalError('Choose the pieces to write off.'); return }
    } else if (!voidQuantity || voidQuantity < 1 || voidQuantity > sellable) {
      setLocalError(sellable === 0 ? 'Every piece is reserved for a customer.' : `Quantity must be between 1 and ${sellable}.`)
      return
    }
    setLocalError('')
    onConfirm(effectiveReason, count, perPiece ? Array.from(picked) : [])
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
            <h2 className="text-base font-semibold text-slate-900">Write Off Item</h2>
            <p className="mt-0.5 text-sm text-slate-500">
              The pieces you write off leave the shelf for good. <span className="font-medium text-slate-800">{product.name}</span> stays on sale with any pieces left; writing off every piece moves it to the Trash. All history is kept.
            </p>
          </div>
        </div>

        {/* Body */}
        <div className="space-y-4 p-5">
          {/* Item summary */}
          <div className="rounded-xl border border-slate-100 bg-slate-50 px-4 py-3 text-sm">
            <div className="flex justify-between text-slate-500"><span>Category</span><span className="font-medium text-slate-800">{product.category}</span></div>
            <div className="mt-1 flex justify-between gap-3 text-slate-500"><span>Condition</span><span className="text-right font-medium text-slate-800">{perPiece ? (pieceConditions || '—') : (product.condition === 'Refurbished' ? 'Good' : 'New')}</span></div>
            <div className="mt-1 flex justify-between text-slate-500"><span>Stock</span><span className="font-medium text-slate-800">{product.quantity}{product.reservedStock > 0 ? ` (${Math.min(product.reservedStock, product.quantity)} reserved)` : ''}</span></div>
          </div>

          {/* Per-piece items: tick the pieces */}
          {perPiece && (
            <div>
              <label className="mb-1.5 block text-sm font-medium text-slate-700">
                Pieces to write off <span className="text-red-500">*</span>
                <span className="ml-1 font-normal text-slate-500">({picked.size} of {pieces?.length ?? 0} on the shelf)</span>
              </label>
              {pieces === null ? (
                <p className="text-xs text-slate-500">Loading pieces…</p>
              ) : pieces.length === 0 ? (
                <p className="text-xs text-slate-500">No pieces on the shelf to write off{product.reservedStock > 0 ? ' - the rest are reserved' : ''}.</p>
              ) : (
                <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-1.5">
                  {pieces.map((u) => (
                    <label key={u.id} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-slate-50">
                      <input type="checkbox" checked={picked.has(u.id)}
                        onChange={() => setPicked((prev) => { const next = new Set(prev); if (next.has(u.id)) next.delete(u.id); else next.add(u.id); return next })} />
                      <span className="font-mono text-slate-600">#{u.unitCode}</span>
                      <span className="font-semibold text-slate-800">{u.grade}</span>
                      <span className="min-w-0 flex-1 truncate text-slate-500">{u.conditionNotes}</span>
                    </label>
                  ))}
                </div>
              )}
              {pieces && picked.size > 0 && (
                <p className={`mt-1.5 text-xs font-medium ${picked.size === product.quantity ? 'text-amber-600' : 'text-blue-600'}`}>
                  {picked.size === product.quantity ? 'Every piece chosen - the item will be fully written off.' : `Stock goes down by ${picked.size}; the rest stay on sale.`}
                </p>
              )}
            </div>
          )}

          {/* Quantity to void (counted-only items) */}
          {!perPiece && (
          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-700">
              Quantity to Void <span className="text-red-500">*</span>
              <span className="ml-1 font-normal text-slate-500">(max: {sellable})</span>
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
                max={sellable}
                value={voidQuantity}
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10)
                  if (!isNaN(val)) setVoidQuantity(Math.min(sellable, Math.max(1, val)))
                }}
                className="w-20 rounded-lg border border-slate-200 px-3 py-2 text-center text-sm font-medium text-slate-800 focus:border-blue-600 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setVoidQuantity((q) => Math.min(sellable, q + 1))}
                className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 transition-colors"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" /></svg>
              </button>
              <span className="text-xs text-slate-500">of {product.quantity} units</span>
            </div>
            {voidQuantity === product.quantity && (
              <p className="mt-1.5 text-xs text-amber-600 font-medium">All units selected — item will be fully voided.</p>
            )}
            {voidQuantity < product.quantity && (
              <p className="mt-1.5 text-xs text-blue-600">Partial void — stock will be reduced by {voidQuantity} unit{voidQuantity !== 1 ? 's' : ''}.</p>
            )}
          </div>
          )}

          {/* Reason dropdown */}
          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-700">Write-off Reason <span className="text-red-500">*</span></label>
            <select
              value={reason}
              onChange={(e) => { setReason(e.target.value); setLocalError('') }}
              className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 focus:border-blue-600 focus:outline-none"
            >
              <option value="">Select a reason…</option>
              {VOID_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>

          {/* Custom reason */}
          {reason === 'Other' && (
            <div>
              <label className="mb-1.5 block text-sm font-medium text-slate-700">Describe the reason <span className="text-red-500">*</span></label>
              <textarea maxLength={INPUT_LIMITS.note}
                value={customReason}
                onChange={(e) => { setCustomReason(e.target.value); setLocalError('') }}
                rows={3}
                placeholder="Provide a specific reason for voiding this item..."
                className="w-full resize-none rounded-xl border border-slate-200 px-3 py-2.5 text-sm text-slate-800 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none"
              />
            </div>
          )}

          {/* Warning */}
          <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5">
            <svg className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            </svg>
            <p className="text-xs text-amber-700">Written-off items are hidden from Sales POS and Reservation creation but remain in stock logs, analytics, and history.</p>
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
            Write off
          </button>
        </div>
      </div>
    </div>
  )
}
