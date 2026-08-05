'use client'

// Containers page - profitability per incoming shipment.
//
// The shop buys surplus by the container. This screen answers the question
// paper records cannot: was this particular shipment worth buying?
//
// For each container it computes:
//   revenue       - total sales of items that came from it
//   profit        - revenue minus the container's purchase cost
//   ROI           - profit as a percentage of that cost
//   sell-through  - how much of the shipment has actually sold
//
// Items are linked to a container by containerId on the inventory record.
//
// Layout: ContainerModal (add/edit a container), AddItemModal (add an item
// straight into a container), ContainerCard (one shipment's summary), then
// ContainersContent which loads the data and renders the list.

import { useEffect, useMemo, useState } from 'react'
import {
  collection,
  getDocs,
  addDoc,
  updateDoc,
  doc,
  serverTimestamp,
  Timestamp,
} from 'firebase/firestore'
import { db, auth } from '@/lib/firebase'
import ProtectedRoute from '@/components/shared/ProtectedRoute'
import {
  Package2,
  Plus,
  X,
  ChevronDown,
  ChevronUp,
  TrendingUp,
  TrendingDown,
  Minus,
  AlertCircle,
  CheckCircle2,
  Clock,
  Pencil,
  Search,
  BoxesIcon,
  ShoppingBag,
} from 'lucide-react'
import { toast } from 'sonner'
import { openLabelPrintWindow } from '@/lib/transactions/labelPrint'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ContainerDoc {
  id: string
  name: string
  supplier: string
  purchaseCost: number
  purchaseDate: string
  notes: string
  status: 'Active' | 'Partially Sold' | 'Sold Out'
  createdAt?: Timestamp
}

interface InventoryItem {
  id: string
  name: string
  categoryId?: string
  categoryName?: string
  price: number
  quantity: number
  condition: string
  containerId?: string
  barcode?: string
}

interface Category {
  id: string
  name: string
}

interface SaleItem {
  itemId?: string
  name: string
  quantity: number
  price: number
  // Units given back to the customer. Written by /api/sales/refund and may be
  // absent on sales made before partial refunds existed, hence optional.
  refundedQuantity?: number
}

interface SaleDoc {
  id: string
  items?: SaleItem[]
  status?: string
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const toNumber = (v: unknown, fallback = 0): number => {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') { const n = Number(v); if (Number.isFinite(n)) return n }
  return fallback
}
const fmt = (n: number) => '₱' + n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const statusConfig = {
  Active:           { color: 'bg-blue-100 text-blue-700',   icon: Clock },
  'Partially Sold': { color: 'bg-amber-100 text-amber-700', icon: Package2 },
  'Sold Out':       { color: 'bg-green-100 text-green-700', icon: CheckCircle2 },
} as const

// ── Container Modal (add / edit container) ─────────────────────────────────────

interface ContainerModalProps {
  isOpen: boolean
  onClose: () => void
  onSubmit: (values: Omit<ContainerDoc, 'id' | 'createdAt'>) => Promise<void>
  initialValues?: Partial<ContainerDoc>
  submitting?: boolean
}

function ContainerModal({ isOpen, onClose, onSubmit, initialValues, submitting }: ContainerModalProps) {
  const [name, setName] = useState('')
  const [supplier, setSupplier] = useState('')
  const [purchaseCost, setPurchaseCost] = useState('')
  const [purchaseDate, setPurchaseDate] = useState('')
  const [notes, setNotes] = useState('')
  const [status, setStatus] = useState<ContainerDoc['status']>('Active')

  useEffect(() => {
    if (!isOpen) return
    if (initialValues) {
      setName(initialValues.name ?? '')
      setSupplier(initialValues.supplier ?? '')
      setPurchaseCost(initialValues.purchaseCost != null ? String(initialValues.purchaseCost) : '')
      setPurchaseDate(initialValues.purchaseDate ?? '')
      setNotes(initialValues.notes ?? '')
      setStatus(initialValues.status ?? 'Active')
    } else {
      setName(''); setSupplier(''); setPurchaseCost('')
      setPurchaseDate(new Date().toISOString().slice(0, 10))
      setNotes(''); setStatus('Active')
    }
  }, [isOpen, initialValues])

  if (!isOpen) return null

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const cost = Number(purchaseCost)
    if (!name.trim() || !supplier.trim() || !purchaseDate || !Number.isFinite(cost) || cost <= 0) {
      toast.error('Please fill in all required fields.'); return
    }
    await onSubmit({ name: name.trim(), supplier: supplier.trim(), purchaseCost: cost, purchaseDate, notes: notes.trim(), status })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <h2 className="text-lg font-semibold text-gray-800">{initialValues?.id ? 'Edit Shipment' : 'Add Shipment'}</h2>
          <button onClick={onClose} className="rounded-lg p-1 hover:bg-gray-100"><X className="h-5 w-5 text-gray-500" /></button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4 px-6 py-5">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Shipment Name / Number <span className="text-red-500">*</span></label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Container #001 – Jan 2025"
              className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100" />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Supplier / Source <span className="text-red-500">*</span></label>
            <input value={supplier} onChange={e => setSupplier(e.target.value)} placeholder="e.g. Japan Surplus Dealer Co."
              className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Purchase Cost (₱) <span className="text-red-500">*</span></label>
              <input type="number" min="0" step="0.01" value={purchaseCost} onChange={e => setPurchaseCost(e.target.value)} placeholder="0.00"
                className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100" />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Purchase Date <span className="text-red-500">*</span></label>
              <input type="date" value={purchaseDate} onChange={e => setPurchaseDate(e.target.value)}
                className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100" />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Status</label>
            <select value={status} onChange={e => setStatus(e.target.value as ContainerDoc['status'])}
              className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100">
              <option value="Active">Active</option>
              <option value="Partially Sold">Partially Sold</option>
              <option value="Sold Out">Sold Out</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Notes</label>
            <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} placeholder="Optional notes…"
              className="w-full resize-none rounded-xl border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100" />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="rounded-xl border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50">Cancel</button>
            <button type="submit" disabled={submitting} className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60">
              {submitting ? 'Saving…' : initialValues?.id ? 'Save Changes' : 'Add Shipment'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Add Item to Container Modal ────────────────────────────────────────────────

interface AddItemModalProps {
  isOpen: boolean
  containerName: string
  categories: Category[]
  onClose: () => void
  onSubmit: (values: {
    name: string; categoryId: string; categoryName: string
    price: number; quantity: number; minStock: number
    condition: 'New' | 'Refurbished'
  }) => Promise<void>
  submitting?: boolean
}

function AddItemModal({ isOpen, containerName, categories, onClose, onSubmit, submitting }: AddItemModalProps) {
  const [name, setName] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [price, setPrice] = useState('')
  const [quantity, setQuantity] = useState('')
  const [minStock, setMinStock] = useState('1')
  const [condition, setCondition] = useState<'New' | 'Refurbished'>('New')

  useEffect(() => {
    if (!isOpen) return
    setName(''); setPrice(''); setQuantity(''); setMinStock('1'); setCondition('New')
    setCategoryId(categories[0]?.id ?? '')
  }, [isOpen, categories])

  if (!isOpen) return null

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const parsedPrice = Number(price)
    const parsedQty = Math.floor(Number(quantity))
    const parsedMin = Math.floor(Number(minStock))
    const cat = categories.find(c => c.id === categoryId)
    if (!name.trim() || !cat || !Number.isFinite(parsedPrice) || parsedPrice <= 0 || parsedQty < 1 || parsedMin < 0) {
      toast.error('Please fill in all required fields correctly.'); return
    }
    await onSubmit({ name: name.trim(), categoryId: cat.id, categoryName: cat.name, price: parsedPrice, quantity: parsedQty, minStock: parsedMin, condition })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-800">Add Item to Shipment</h2>
            <p className="text-xs text-gray-500 mt-0.5">{containerName}</p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1 hover:bg-gray-100"><X className="h-5 w-5 text-gray-500" /></button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4 px-6 py-5">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Item Name <span className="text-red-500">*</span></label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Rice Cooker"
              className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Category <span className="text-red-500">*</span></label>
              <select value={categoryId} onChange={e => setCategoryId(e.target.value)}
                className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm focus:border-blue-400 focus:outline-none">
                <option value="">Select…</option>
                {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Condition <span className="text-red-500">*</span></label>
              <select value={condition} onChange={e => setCondition(e.target.value as 'New' | 'Refurbished')}
                className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm focus:border-blue-400 focus:outline-none">
                <option value="New">New</option>
                <option value="Refurbished">Refurbished</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Price (₱) <span className="text-red-500">*</span></label>
              <input type="number" min="0.01" step="0.01" value={price} onChange={e => setPrice(e.target.value)} placeholder="0.00"
                className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100" />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Qty <span className="text-red-500">*</span></label>
              <input type="number" min="1" value={quantity} onChange={e => setQuantity(e.target.value)} placeholder="0"
                className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100" />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Min Stock</label>
              <input type="number" min="0" value={minStock} onChange={e => setMinStock(e.target.value)} placeholder="1"
                className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100" />
            </div>
          </div>
          <p className="rounded-xl bg-blue-50 px-3 py-2 text-xs text-blue-700">
            This item will be added to Inventory and linked to this container automatically.
          </p>
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="rounded-xl border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50">Cancel</button>
            <button type="submit" disabled={submitting} className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60">
              {submitting ? 'Adding…' : 'Add to Inventory'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Container Card ─────────────────────────────────────────────────────────────

interface ContainerCardProps {
  container: ContainerDoc
  inventory: InventoryItem[]
  soldQtyMap: Record<string, number>
  onEdit: () => void
  onAddItem: () => void
}

function ContainerCard({ container, inventory, soldQtyMap, onEdit, onAddItem }: ContainerCardProps) {
  const [expanded, setExpanded] = useState(false)

  const linkedItems = useMemo(
    () => inventory.filter(item => item.containerId === container.id),
    [inventory, container.id]
  )

  const stats = useMemo(() => {
    let revenue = 0
    let totalOriginalUnits = 0
    let soldUnits = 0
    let availableUnits = 0

    for (const item of linkedItems) {
      const soldQty = soldQtyMap[item.id] ?? 0
      const currentStock = toNumber(item.quantity)
      // original = current stock + qty sold (from actual sales)
      const originalQty = currentStock + soldQty
      totalOriginalUnits += originalQty
      soldUnits += soldQty
      availableUnits += currentStock
      revenue += soldQty * toNumber(item.price)
    }

    const profit = revenue - container.purchaseCost
    const roi = container.purchaseCost > 0 ? (profit / container.purchaseCost) * 100 : 0
    const sellThrough = totalOriginalUnits > 0 ? (soldUnits / totalOriginalUnits) * 100 : 0

    return { revenue, profit, roi, totalOriginalUnits, soldUnits, availableUnits, sellThrough, linkedCount: linkedItems.length }
  }, [linkedItems, soldQtyMap, container.purchaseCost])

  const StatusIcon = statusConfig[container.status]?.icon ?? Clock

  return (
    <div className="rounded-2xl border border-gray-100 bg-white shadow-sm overflow-hidden">
      {/* ── Header row ── */}
      <div className="flex items-center justify-between gap-4 p-5">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-50">
            <Package2 className="h-5 w-5 text-blue-600" />
          </div>
          <div className="min-w-0">
            <p className="truncate font-semibold text-gray-800">{container.name}</p>
            <p className="truncate text-xs text-gray-500">{container.supplier} · {container.purchaseDate}</p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <span className={`hidden sm:flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${statusConfig[container.status]?.color ?? 'bg-gray-100 text-gray-600'}`}>
            <StatusIcon className="h-3 w-3" />
            {container.status}
          </span>

          {/* Quick profit badge */}
          <div className="hidden items-center gap-4 rounded-xl bg-gray-50 px-4 py-2 sm:flex">
            <div className="text-center">
              <p className="text-[10px] uppercase tracking-wide text-gray-400">Cost</p>
              <p className="text-sm font-semibold text-gray-700">{fmt(container.purchaseCost)}</p>
            </div>
            <div className="h-6 w-px bg-gray-200" />
            <div className="text-center">
              <p className="text-[10px] uppercase tracking-wide text-gray-400">Revenue</p>
              <p className="text-sm font-semibold text-gray-700">{fmt(stats.revenue)}</p>
            </div>
            <div className="h-6 w-px bg-gray-200" />
            <div className="text-center">
              <p className="text-[10px] uppercase tracking-wide text-gray-400">Profit</p>
              <p className={`text-sm font-bold ${stats.profit > 0 ? 'text-green-600' : stats.profit < 0 ? 'text-red-500' : 'text-gray-500'}`}>
                {stats.profit >= 0 ? '+' : ''}{fmt(stats.profit)}
              </p>
            </div>
          </div>

          <button onClick={onEdit} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600" title="Edit shipment">
            <Pencil className="h-4 w-4" />
          </button>
          <button onClick={() => setExpanded(v => !v)} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600">
            {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {/* Sell-through progress bar */}
      {stats.totalOriginalUnits > 0 && (
        <div className="px-5 pb-3">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[11px] text-gray-400">Sell-through progress</span>
            <span className="text-[11px] font-semibold text-gray-600">{stats.sellThrough.toFixed(0)}% sold</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-gray-100">
            <div
              className={`h-1.5 rounded-full transition-all ${stats.sellThrough >= 100 ? 'bg-green-500' : stats.sellThrough >= 50 ? 'bg-blue-500' : 'bg-amber-400'}`}
              style={{ width: `${Math.min(100, stats.sellThrough)}%` }}
            />
          </div>
          <div className="mt-1 flex gap-3 text-[11px] text-gray-400">
            <span><span className="font-medium text-blue-600">{stats.soldUnits}</span> sold</span>
            <span className="text-gray-300">·</span>
            <span><span className={`font-medium ${stats.availableUnits > 0 ? 'text-gray-700' : 'text-red-400'}`}>{stats.availableUnits}</span> still available</span>
          </div>
        </div>
      )}

      {/* ── Expanded detail ── */}
      {expanded && (
        <div className="border-t border-gray-100 px-5 pb-5 pt-4">
          {/* Mobile quick stats */}
          <div className="mb-4 grid grid-cols-3 gap-3 sm:hidden">
            {[
              { label: 'Cost', value: fmt(container.purchaseCost), color: 'text-gray-700' },
              { label: 'Revenue', value: fmt(stats.revenue), color: 'text-gray-700' },
              { label: 'Profit', value: (stats.profit >= 0 ? '+' : '') + fmt(stats.profit), color: stats.profit > 0 ? 'text-green-600' : stats.profit < 0 ? 'text-red-500' : 'text-gray-500' },
            ].map(s => (
              <div key={s.label} className="rounded-xl bg-gray-50 p-3 text-center">
                <p className="text-[10px] uppercase tracking-wide text-gray-400">{s.label}</p>
                <p className={`text-sm font-bold ${s.color}`}>{s.value}</p>
              </div>
            ))}
          </div>

          {/* Profit summary row */}
          <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl bg-gradient-to-r from-blue-50 to-indigo-50 p-4">
            <div className="flex items-center gap-2">
              {stats.profit > 0 ? <TrendingUp className="h-5 w-5 text-green-500" /> : stats.profit < 0 ? <TrendingDown className="h-5 w-5 text-red-400" /> : <Minus className="h-5 w-5 text-gray-400" />}
              <span className="text-sm text-gray-600">
                ROI: <span className={`font-bold ${stats.roi > 0 ? 'text-green-600' : stats.roi < 0 ? 'text-red-500' : 'text-gray-500'}`}>{stats.roi >= 0 ? '+' : ''}{stats.roi.toFixed(1)}%</span>
              </span>
            </div>
            <span className="text-gray-300">|</span>
            <span className="text-sm text-gray-600">
              <span className="font-semibold text-gray-800">{stats.linkedCount}</span> item line{stats.linkedCount !== 1 ? 's' : ''}
            </span>
            {container.notes && (
              <>
                <span className="text-gray-300">|</span>
                <span className="text-xs italic text-gray-400">{container.notes}</span>
              </>
            )}
          </div>

          {/* Add item button */}
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-700">Items in this Shipment</h3>
            <div className="flex items-center gap-2">
            {linkedItems.length > 0 && (
              <button
                onClick={() => {
                  // One label per unit, for every item in the shipment. This is
                  // the arrival workflow: unpack, print the sheet, label as you go.
                  const withCodes = linkedItems.filter((i) => i.barcode)
                  if (withCodes.length === 0) {
                    toast.error('No barcodes assigned yet. Run Assign Barcodes in Inventory first.')
                    return
                  }
                  withCodes.forEach((i) =>
                    openLabelPrintWindow(
                      {
                        name: i.name,
                        barcode: i.barcode as string,
                        price: i.price,
                        condition: i.condition,
                        categoryName: i.categoryName,
                      },
                      Math.max(1, i.quantity)
                    )
                  )
                }}
                className="flex items-center gap-1.5 rounded-xl border border-violet-200 px-3 py-1.5 text-xs font-semibold text-violet-700 hover:bg-violet-50"
              >
                Print Labels
              </button>
            )}
            <button
              onClick={onAddItem}
              className="flex items-center gap-1.5 rounded-xl bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700"
            >
              <Plus className="h-3.5 w-3.5" />
              Add Item
            </button>
            </div>
          </div>

          {linkedItems.length === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-gray-200 py-10 text-center">
              <BoxesIcon className="h-8 w-8 text-gray-200" />
              <p className="text-sm text-gray-400 font-medium">No items added to this shipment yet.</p>
              <p className="text-xs text-gray-400 max-w-xs">Click <span className="font-semibold">Add Item</span> above to log items from this shipment into Inventory.</p>
              <button
                onClick={onAddItem}
                className="mt-1 flex items-center gap-1.5 rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                <Plus className="h-4 w-4" />
                Add First Item
              </button>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-gray-100">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 text-left text-xs font-medium uppercase tracking-wide text-gray-400">
                    <th className="px-4 py-2.5">Item</th>
                    <th className="px-4 py-2.5">Condition</th>
                    <th className="px-4 py-2.5 text-right">Price</th>
                    <th className="px-4 py-2.5 text-center">Sold</th>
                    <th className="px-4 py-2.5 text-center">Available</th>
                    <th className="px-4 py-2.5 text-right">Revenue</th>
                    <th className="px-4 py-2.5 text-center">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {linkedItems.map(item => {
                    const soldQty = soldQtyMap[item.id] ?? 0
                    const available = toNumber(item.quantity)
                    const itemRevenue = soldQty * item.price
                    const isClear = available === 0
                    return (
                      <tr key={item.id} className={`hover:bg-gray-50/50 ${isClear ? 'opacity-60' : ''}`}>
                        <td className="px-4 py-3">
                          <p className="font-medium text-gray-700">{item.name}</p>
                          <p className="text-xs text-gray-400">{item.categoryName ?? '—'}</p>
                        </td>
                        <td className="px-4 py-3">
                          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${item.condition === 'New' ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-700'}`}>
                            {item.condition}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right text-gray-600">{fmt(item.price)}</td>
                        <td className="px-4 py-3 text-center">
                          <span className="font-semibold text-blue-600">{soldQty}</span>
                        </td>
                        <td className="px-4 py-3 text-center">
                          <span className={`font-semibold ${available > 0 ? 'text-gray-800' : 'text-red-400'}`}>{available}</span>
                        </td>
                        <td className="px-4 py-3 text-right font-semibold text-gray-800">{fmt(itemRevenue)}</td>
                        <td className="px-4 py-3 text-center">
                          {isClear ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700">
                              <CheckCircle2 className="h-3 w-3" /> Cleared
                            </span>
                          ) : available <= 2 ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
                              <AlertCircle className="h-3 w-3" /> Low
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-600">
                              <ShoppingBag className="h-3 w-3" /> Available
                            </span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-gray-200 bg-gray-50/50">
                    <td colSpan={3} className="px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-gray-400">Total</td>
                    <td className="px-4 py-2.5 text-center font-bold text-blue-600">{stats.soldUnits}</td>
                    <td className="px-4 py-2.5 text-center font-bold text-gray-800">{stats.availableUnits}</td>
                    <td className="px-4 py-2.5 text-right font-bold text-gray-800">{fmt(stats.revenue)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export default function ContainersPage() {
  return <ProtectedRoute><ContainersContent /></ProtectedRoute>
}

function ContainersContent() {
  const [containers, setContainers]   = useState<ContainerDoc[]>([])
  const [inventory, setInventory]     = useState<InventoryItem[]>([])
  const [sales, setSales]             = useState<SaleDoc[]>([])
  const [categories, setCategories]   = useState<Category[]>([])
  const [loading, setLoading]         = useState(true)

  const [search, setSearch]           = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')

  const [containerModal, setContainerModal] = useState(false)
  const [editingContainer, setEditingContainer] = useState<ContainerDoc | null>(null)
  const [savingContainer, setSavingContainer] = useState(false)

  const [addItemModal, setAddItemModal]         = useState(false)
  const [addItemTarget, setAddItemTarget]       = useState<ContainerDoc | null>(null)
  const [savingItem, setSavingItem]             = useState(false)

  // One-time fetch (containers page doesn't need live updates)
  useEffect(() => {
    let cancelled = false
    async function loadData() {
      try {
        const [contSnap, invSnap, salesSnap, catSnap] = await Promise.all([
          getDocs(collection(db, 'containers')),
          getDocs(collection(db, 'inventory')),
          getDocs(collection(db, 'sales')),
          getDocs(collection(db, 'categories')),
        ])
        if (cancelled) return
        const docs: ContainerDoc[] = contSnap.docs.map(d => {
          const data = d.data() as Record<string, unknown>
          return {
            id: d.id,
            name: String(data.name ?? ''),
            supplier: String(data.supplier ?? ''),
            purchaseCost: toNumber(data.purchaseCost),
            purchaseDate: String(data.purchaseDate ?? ''),
            notes: String(data.notes ?? ''),
            status: (data.status as ContainerDoc['status']) ?? 'Active',
            createdAt: data.createdAt as Timestamp | undefined,
          }
        })
        docs.sort((a, b) => {
          if (a.createdAt && b.createdAt) return b.createdAt.seconds - a.createdAt.seconds
          return b.purchaseDate.localeCompare(a.purchaseDate)
        })
        setContainers(docs)
        setInventory(invSnap.docs.map(d => {
          const data = d.data() as Record<string, unknown>
          return {
            id: d.id,
            name: String(data.name ?? ''),
            categoryId: String(data.categoryId ?? ''),
            categoryName: String(data.categoryName ?? data.category ?? ''),
            price: toNumber(data.price),
            quantity: toNumber(data.stock ?? data.quantity),
            condition: String(data.condition ?? 'New'),
            barcode: typeof data.barcode === 'string' ? data.barcode : undefined,
            containerId: data.containerId ? String(data.containerId) : undefined,
          }
        }))
        setSales(salesSnap.docs.map(d => {
          const data = d.data() as Record<string, unknown>
          return {
            id: d.id,
            items: Array.isArray(data.items) ? (data.items as SaleItem[]) : [],
            status: String(data.status ?? 'completed'),
          }
        }))
        const list: Category[] = catSnap.docs
          .map(d => { const data = d.data() as Record<string, unknown>; return { id: d.id, name: String(data.name ?? '').trim() } })
          .filter(c => c.name)
        list.sort((a, b) => a.name.localeCompare(b.name))
        setCategories(list)
        setLoading(false)
      } catch (_) { setLoading(false) }
    }
    loadData()
    return () => { cancelled = true }
  }, [])

  // Precompute how many units of each item actually stayed sold.
  //
  // Two things are excluded, because neither earned the shop any money:
  //   • voided sales      - the whole transaction was cancelled
  //   • refunded quantity - those units came back and were paid back
  //
  // Refunds are subtracted per line, not per sale, because a sale can be
  // partially refunded (2 of 5 units returned). Counting a refunded unit as
  // sold would overstate container revenue, profit, ROI and sell-through.
  const soldQtyMap = useMemo(() => {
    const map: Record<string, number> = {}
    for (const sale of sales) {
      if (sale.status === 'voided') continue
      for (const si of sale.items ?? []) {
        if (!si.itemId) continue
        const netQty = toNumber(si.quantity) - toNumber(si.refundedQuantity)
        if (netQty <= 0) continue
        map[si.itemId] = (map[si.itemId] ?? 0) + netQty
      }
    }
    return map
  }, [sales])

  const filtered = useMemo(() => {
    let list = containers
    if (statusFilter !== 'all') list = list.filter(c => c.status === statusFilter)
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter(c => c.name.toLowerCase().includes(q) || c.supplier.toLowerCase().includes(q))
    }
    return list
  }, [containers, statusFilter, search])

  // Summary across all containers
  const summary = useMemo(() => {
    let totalCost = 0, totalRevenue = 0
    for (const c of containers) {
      totalCost += c.purchaseCost
      const linked = inventory.filter(item => item.containerId === c.id)
      for (const item of linked) {
        totalRevenue += (soldQtyMap[item.id] ?? 0) * item.price
      }
    }
    return { totalCost, totalRevenue, totalProfit: totalRevenue - totalCost }
  }, [containers, inventory, soldQtyMap])

  // Handlers
  const handleSaveContainer = async (values: Omit<ContainerDoc, 'id' | 'createdAt'>) => {
    setSavingContainer(true)
    try {
      if (editingContainer) {
        await updateDoc(doc(db, 'containers', editingContainer.id), { ...values })
        toast.success('Container updated.')
      } else {
        await addDoc(collection(db, 'containers'), { ...values, createdAt: serverTimestamp() })
        toast.success('Container added.')
      }
      setContainerModal(false); setEditingContainer(null)
    } catch (err) {
      console.error(err); toast.error('Failed to save shipment.')
    } finally {
      setSavingContainer(false)
    }
  }

  const handleAddItem = async (values: {
    name: string; categoryId: string; categoryName: string
    price: number; quantity: number; minStock: number
    condition: 'New' | 'Refurbished'
  }) => {
    if (!addItemTarget) return
    setSavingItem(true)
    try {
      const response = await fetch('/api/inventory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...values,
          containerId: addItemTarget.id,
          processedBy: {
            uid: auth.currentUser?.uid ?? '',
            email: auth.currentUser?.email ?? '',
            name: auth.currentUser?.displayName ?? auth.currentUser?.email ?? '',
          },
        }),
      })
      const payload = (await response.json()) as { error?: string }
      if (!response.ok) throw new Error(payload.error || 'Failed to add item.')
      toast.success(`"${values.name}" added to inventory and linked to ${addItemTarget.name}.`)
      setAddItemModal(false); setAddItemTarget(null)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to add item.'
      toast.error(msg)
    } finally {
      setSavingItem(false)
    }
  }

  const openAddItem = (c: ContainerDoc) => { setAddItemTarget(c); setAddItemModal(true) }
  const openEdit    = (c: ContainerDoc) => { setEditingContainer(c); setContainerModal(true) }
  const openAdd     = () => { setEditingContainer(null); setContainerModal(true) }

  return (
    <div className="min-h-screen bg-gray-50/50 p-6">
      {/* Header */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Shipments</h1>
          <p className="mt-0.5 text-sm text-gray-500">Each shipment from a supplier. Add items directly and see the profit each one made.</p>
        </div>
        <button onClick={openAdd} className="flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-blue-700">
          <Plus className="h-4 w-4" /> Add Container
        </button>
      </div>

      {/* Summary cards */}
      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[
          { label: 'Shipments', value: String(containers.length), color: 'text-gray-800' },
          { label: 'Total Invested', value: fmt(summary.totalCost), color: 'text-gray-800' },
          { label: 'Total Revenue', value: fmt(summary.totalRevenue), color: 'text-blue-600' },
          { label: 'Net Profit', value: (summary.totalProfit >= 0 ? '+' : '') + fmt(summary.totalProfit), color: summary.totalProfit > 0 ? 'text-green-600' : summary.totalProfit < 0 ? 'text-red-500' : 'text-gray-500' },
        ].map(s => (
          <div key={s.label} className="rounded-2xl bg-white p-4 shadow-sm">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-400">{s.label}</p>
            <p className={`mt-1 text-2xl font-bold ${s.color}`}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search shipments…"
            className="w-full rounded-xl border border-gray-200 bg-white py-2 pl-9 pr-3 text-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100" />
        </div>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
          className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm focus:border-blue-400 focus:outline-none">
          <option value="all">All Statuses</option>
          <option value="Active">Active</option>
          <option value="Partially Sold">Partially Sold</option>
          <option value="Sold Out">Sold Out</option>
        </select>
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-gray-200 bg-white py-16 text-center">
          <Package2 className="h-12 w-12 text-gray-200" />
          <p className="font-medium text-gray-400">{containers.length === 0 ? 'No shipments yet.' : 'No shipments match your search.'}</p>
          {containers.length === 0 && (
            <button onClick={openAdd} className="mt-1 flex items-center gap-1.5 rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
              <Plus className="h-4 w-4" /> Add your first container
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map(c => (
            <ContainerCard
              key={c.id}
              container={c}
              inventory={inventory}
              soldQtyMap={soldQtyMap}
              onEdit={() => openEdit(c)}
              onAddItem={() => openAddItem(c)}
            />
          ))}
        </div>
      )}

      {/* Modals */}
      <ContainerModal
        isOpen={containerModal}
        onClose={() => { setContainerModal(false); setEditingContainer(null) }}
        onSubmit={handleSaveContainer}
        initialValues={editingContainer ?? undefined}
        submitting={savingContainer}
      />

      <AddItemModal
        isOpen={addItemModal}
        containerName={addItemTarget?.name ?? ''}
        categories={categories}
        onClose={() => { setAddItemModal(false); setAddItemTarget(null) }}
        onSubmit={handleAddItem}
        submitting={savingItem}
      />
    </div>
  )
}
