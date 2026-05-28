'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  collection,
  onSnapshot,
  addDoc,
  updateDoc,
  doc,
  serverTimestamp,
  Timestamp,
} from 'firebase/firestore'
import { db } from '@/lib/firebase'
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
} from 'lucide-react'
import { toast } from 'sonner'

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
  categoryName?: string
  price: number
  quantity: number
  originalQuantity?: number
  condition: string
  containerId?: string
}

interface SaleItem {
  itemId?: string
  name: string
  quantity: number
  price: number
}

interface SaleDoc {
  id: string
  items?: SaleItem[]
  totalAmount?: number
  status?: string
  createdAt?: unknown
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const toNumber = (v: unknown, fallback = 0): number => {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return fallback
}

const formatPeso = (n: number) =>
  '₱' + n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const statusConfig = {
  Active: { color: 'bg-blue-100 text-blue-700', icon: Clock },
  'Partially Sold': { color: 'bg-amber-100 text-amber-700', icon: Package2 },
  'Sold Out': { color: 'bg-green-100 text-green-700', icon: CheckCircle2 },
} as const

// ── Modal ──────────────────────────────────────────────────────────────────────

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
      setName('')
      setSupplier('')
      setPurchaseCost('')
      setPurchaseDate(new Date().toISOString().slice(0, 10))
      setNotes('')
      setStatus('Active')
    }
  }, [isOpen, initialValues])

  if (!isOpen) return null

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const cost = Number(purchaseCost)
    if (!name.trim() || !supplier.trim() || !purchaseDate || !Number.isFinite(cost) || cost <= 0) {
      toast.error('Please fill in all required fields.')
      return
    }
    await onSubmit({
      name: name.trim(),
      supplier: supplier.trim(),
      purchaseCost: cost,
      purchaseDate,
      notes: notes.trim(),
      status,
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <h2 className="text-lg font-semibold text-gray-800">
            {initialValues?.id ? 'Edit Container' : 'Add Container'}
          </h2>
          <button onClick={onClose} className="rounded-lg p-1 hover:bg-gray-100">
            <X className="h-5 w-5 text-gray-500" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4 px-6 py-5">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">
              Container Name / Number <span className="text-red-500">*</span>
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Container #001 – Jan 2025"
              className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">
              Supplier / Source <span className="text-red-500">*</span>
            </label>
            <input
              value={supplier}
              onChange={(e) => setSupplier(e.target.value)}
              placeholder="e.g. Japan Surplus Dealer Co."
              className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">
                Purchase Cost (₱) <span className="text-red-500">*</span>
              </label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={purchaseCost}
                onChange={(e) => setPurchaseCost(e.target.value)}
                placeholder="0.00"
                className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">
                Purchase Date <span className="text-red-500">*</span>
              </label>
              <input
                type="date"
                value={purchaseDate}
                onChange={(e) => setPurchaseDate(e.target.value)}
                className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100"
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Status</label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as ContainerDoc['status'])}
              className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100"
            >
              <option value="Active">Active</option>
              <option value="Partially Sold">Partially Sold</option>
              <option value="Sold Out">Sold Out</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Notes</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="Optional notes about this container…"
              className="w-full resize-none rounded-xl border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100"
            />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
            >
              {submitting ? 'Saving…' : initialValues?.id ? 'Save Changes' : 'Add Container'}
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
  sales: SaleDoc[]
  onEdit: () => void
}

function ContainerCard({ container, inventory, sales, onEdit }: ContainerCardProps) {
  const [expanded, setExpanded] = useState(false)

  // Items tagged to this container
  const linkedItems = useMemo(
    () => inventory.filter((item) => item.containerId === container.id),
    [inventory, container.id]
  )

  // Revenue: sum quantities sold from completed sales × price
  // Build a map: itemId → total qty sold
  const soldQtyMap = useMemo(() => {
    const map: Record<string, number> = {}
    for (const sale of sales) {
      if (sale.status === 'voided') continue
      for (const si of sale.items ?? []) {
        if (!si.itemId) continue
        map[si.itemId] = (map[si.itemId] ?? 0) + toNumber(si.quantity)
      }
    }
    return map
  }, [sales])

  const stats = useMemo(() => {
    let revenue = 0
    let totalItems = 0
    let soldItems = 0

    for (const item of linkedItems) {
      const soldQty = soldQtyMap[item.id] ?? 0
      const origQty = toNumber(item.originalQuantity ?? item.quantity) + soldQty // approximate
      totalItems += origQty
      soldItems += soldQty
      revenue += soldQty * toNumber(item.price)
    }

    const profit = revenue - container.purchaseCost
    const roi = container.purchaseCost > 0 ? (profit / container.purchaseCost) * 100 : 0

    return { revenue, profit, roi, totalItems, soldItems, linkedCount: linkedItems.length }
  }, [linkedItems, soldQtyMap, container.purchaseCost])

  const StatusIcon = statusConfig[container.status]?.icon ?? Clock

  return (
    <div className="rounded-2xl border border-gray-100 bg-white shadow-sm">
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
          {/* Status badge */}
          <span
            className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${statusConfig[container.status]?.color ?? 'bg-gray-100 text-gray-600'}`}
          >
            <StatusIcon className="h-3 w-3" />
            {container.status}
          </span>

          {/* Quick stats */}
          <div className="hidden items-center gap-4 rounded-xl bg-gray-50 px-4 py-2 sm:flex">
            <div className="text-center">
              <p className="text-[10px] uppercase tracking-wide text-gray-400">Cost</p>
              <p className="text-sm font-semibold text-gray-700">{formatPeso(container.purchaseCost)}</p>
            </div>
            <div className="h-6 w-px bg-gray-200" />
            <div className="text-center">
              <p className="text-[10px] uppercase tracking-wide text-gray-400">Revenue</p>
              <p className="text-sm font-semibold text-gray-700">{formatPeso(stats.revenue)}</p>
            </div>
            <div className="h-6 w-px bg-gray-200" />
            <div className="text-center">
              <p className="text-[10px] uppercase tracking-wide text-gray-400">Profit</p>
              <p
                className={`text-sm font-bold ${stats.profit > 0 ? 'text-green-600' : stats.profit < 0 ? 'text-red-500' : 'text-gray-500'}`}
              >
                {stats.profit >= 0 ? '+' : ''}{formatPeso(stats.profit)}
              </p>
            </div>
          </div>

          <button
            onClick={onEdit}
            className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            title="Edit container"
          >
            <Pencil className="h-4 w-4" />
          </button>
          <button
            onClick={() => setExpanded((v) => !v)}
            className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            title={expanded ? 'Collapse' : 'Expand'}
          >
            {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {/* ── Expanded detail ── */}
      {expanded && (
        <div className="border-t border-gray-100 px-5 pb-5 pt-4">
          {/* Mobile stats */}
          <div className="mb-4 grid grid-cols-3 gap-3 sm:hidden">
            <div className="rounded-xl bg-gray-50 p-3 text-center">
              <p className="text-[10px] uppercase tracking-wide text-gray-400">Cost</p>
              <p className="text-sm font-semibold text-gray-700">{formatPeso(container.purchaseCost)}</p>
            </div>
            <div className="rounded-xl bg-gray-50 p-3 text-center">
              <p className="text-[10px] uppercase tracking-wide text-gray-400">Revenue</p>
              <p className="text-sm font-semibold text-gray-700">{formatPeso(stats.revenue)}</p>
            </div>
            <div className="rounded-xl bg-gray-50 p-3 text-center">
              <p className="text-[10px] uppercase tracking-wide text-gray-400">Profit</p>
              <p className={`text-sm font-bold ${stats.profit > 0 ? 'text-green-600' : stats.profit < 0 ? 'text-red-500' : 'text-gray-500'}`}>
                {stats.profit >= 0 ? '+' : ''}{formatPeso(stats.profit)}
              </p>
            </div>
          </div>

          {/* Profit summary row */}
          <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl bg-gradient-to-r from-blue-50 to-indigo-50 p-4">
            <div className="flex items-center gap-2">
              {stats.profit > 0 ? (
                <TrendingUp className="h-5 w-5 text-green-500" />
              ) : stats.profit < 0 ? (
                <TrendingDown className="h-5 w-5 text-red-400" />
              ) : (
                <Minus className="h-5 w-5 text-gray-400" />
              )}
              <span className="text-sm text-gray-600">
                ROI:{' '}
                <span className={`font-bold ${stats.roi > 0 ? 'text-green-600' : stats.roi < 0 ? 'text-red-500' : 'text-gray-500'}`}>
                  {stats.roi >= 0 ? '+' : ''}{stats.roi.toFixed(1)}%
                </span>
              </span>
            </div>
            <span className="text-gray-300">|</span>
            <span className="text-sm text-gray-600">
              Items sold:{' '}
              <span className="font-semibold text-gray-800">{stats.soldItems}</span>
              {stats.totalItems > 0 && (
                <span className="text-gray-400"> / {stats.totalItems}</span>
              )}
            </span>
            <span className="text-gray-300">|</span>
            <span className="text-sm text-gray-600">
              Inventory lines:{' '}
              <span className="font-semibold text-gray-800">{stats.linkedCount}</span>
            </span>
            {container.notes && (
              <>
                <span className="text-gray-300">|</span>
                <span className="text-xs italic text-gray-400">{container.notes}</span>
              </>
            )}
          </div>

          {/* Inventory items table */}
          {linkedItems.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-gray-200 py-8 text-center">
              <AlertCircle className="h-8 w-8 text-gray-300" />
              <p className="text-sm text-gray-400">No inventory items linked to this container yet.</p>
              <p className="text-xs text-gray-400">
                When adding or editing an item in Inventory, select this container.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 text-left text-xs font-medium uppercase tracking-wide text-gray-400">
                    <th className="pb-2 pr-4">Item</th>
                    <th className="pb-2 pr-4">Condition</th>
                    <th className="pb-2 pr-4 text-right">Price</th>
                    <th className="pb-2 pr-4 text-right">In Stock</th>
                    <th className="pb-2 pr-4 text-right">Qty Sold</th>
                    <th className="pb-2 text-right">Revenue</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {linkedItems.map((item) => {
                    const soldQty = soldQtyMap[item.id] ?? 0
                    const itemRevenue = soldQty * item.price
                    return (
                      <tr key={item.id} className="hover:bg-gray-50/50">
                        <td className="py-2 pr-4 font-medium text-gray-700">{item.name}</td>
                        <td className="py-2 pr-4">
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                              item.condition === 'New'
                                ? 'bg-green-50 text-green-700'
                                : 'bg-amber-50 text-amber-700'
                            }`}
                          >
                            {item.condition}
                          </span>
                        </td>
                        <td className="py-2 pr-4 text-right text-gray-600">{formatPeso(item.price)}</td>
                        <td className="py-2 pr-4 text-right text-gray-600">{item.quantity}</td>
                        <td className="py-2 pr-4 text-right font-medium text-blue-600">{soldQty}</td>
                        <td className="py-2 text-right font-semibold text-gray-800">{formatPeso(itemRevenue)}</td>
                      </tr>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-gray-200">
                    <td colSpan={4} className="pt-2 text-xs font-semibold uppercase tracking-wide text-gray-400">Total</td>
                    <td className="pt-2 text-right font-bold text-blue-600">{linkedItems.reduce((a, item) => a + (soldQtyMap[item.id] ?? 0), 0)}</td>
                    <td className="pt-2 text-right font-bold text-gray-800">{formatPeso(stats.revenue)}</td>
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
  return (
    <ProtectedRoute>
      <ContainersContent />
    </ProtectedRoute>
  )
}

function ContainersContent() {
  const [containers, setContainers] = useState<ContainerDoc[]>([])
  const [inventory, setInventory] = useState<InventoryItem[]>([])
  const [sales, setSales] = useState<SaleDoc[]>([])
  const [loading, setLoading] = useState(true)

  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')

  const [modalOpen, setModalOpen] = useState(false)
  const [editingContainer, setEditingContainer] = useState<ContainerDoc | null>(null)
  const [saving, setSaving] = useState(false)

  // Firestore listeners
  useEffect(() => {
    const unsubs = [
      onSnapshot(collection(db, 'containers'), (snap) => {
        const docs: ContainerDoc[] = snap.docs.map((d) => {
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
        setLoading(false)
      }),

      onSnapshot(collection(db, 'inventory'), (snap) => {
        const docs: InventoryItem[] = snap.docs.map((d) => {
          const data = d.data() as Record<string, unknown>
          return {
            id: d.id,
            name: String(data.name ?? ''),
            categoryName: String(data.categoryName ?? data.category ?? ''),
            price: toNumber(data.price),
            quantity: toNumber(data.quantity),
            originalQuantity: data.originalQuantity != null ? toNumber(data.originalQuantity) : undefined,
            condition: String(data.condition ?? 'New'),
            containerId: data.containerId ? String(data.containerId) : undefined,
          }
        })
        setInventory(docs)
      }),

      onSnapshot(collection(db, 'sales'), (snap) => {
        const docs: SaleDoc[] = snap.docs.map((d) => {
          const data = d.data() as Record<string, unknown>
          return {
            id: d.id,
            items: Array.isArray(data.items) ? (data.items as SaleItem[]) : [],
            totalAmount: toNumber(data.totalAmount),
            status: String(data.status ?? 'completed'),
            createdAt: data.createdAt,
          }
        })
        setSales(docs)
      }),
    ]

    return () => unsubs.forEach((u) => u())
  }, [])

  const filtered = useMemo(() => {
    let list = containers
    if (statusFilter !== 'all') list = list.filter((c) => c.status === statusFilter)
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.supplier.toLowerCase().includes(q) ||
          c.notes.toLowerCase().includes(q)
      )
    }
    return list
  }, [containers, statusFilter, search])

  // Summary stats
  const summary = useMemo(() => {
    const soldQtyMap: Record<string, number> = {}
    for (const sale of sales) {
      if (sale.status === 'voided') continue
      for (const si of sale.items ?? []) {
        if (!si.itemId) continue
        soldQtyMap[si.itemId] = (soldQtyMap[si.itemId] ?? 0) + toNumber(si.quantity)
      }
    }

    let totalCost = 0
    let totalRevenue = 0
    for (const c of containers) {
      totalCost += c.purchaseCost
      const linked = inventory.filter((item) => item.containerId === c.id)
      for (const item of linked) {
        const soldQty = soldQtyMap[item.id] ?? 0
        totalRevenue += soldQty * item.price
      }
    }
    return { totalCost, totalRevenue, totalProfit: totalRevenue - totalCost }
  }, [containers, inventory, sales])

  const handleSave = async (values: Omit<ContainerDoc, 'id' | 'createdAt'>) => {
    setSaving(true)
    try {
      if (editingContainer) {
        await updateDoc(doc(db, 'containers', editingContainer.id), { ...values })
        toast.success('Container updated.')
      } else {
        await addDoc(collection(db, 'containers'), { ...values, createdAt: serverTimestamp() })
        toast.success('Container added.')
      }
      setModalOpen(false)
      setEditingContainer(null)
    } catch (err) {
      console.error(err)
      toast.error('Failed to save container.')
    } finally {
      setSaving(false)
    }
  }

  const openAdd = () => {
    setEditingContainer(null)
    setModalOpen(true)
  }
  const openEdit = (c: ContainerDoc) => {
    setEditingContainer(c)
    setModalOpen(true)
  }

  return (
    <div className="min-h-screen bg-gray-50/50 p-6">
      {/* ── Page header ── */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Containers</h1>
          <p className="mt-0.5 text-sm text-gray-500">
            Track container batches purchased from Japan and monitor profit per container.
          </p>
        </div>
        <button
          onClick={openAdd}
          className="flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-blue-700"
        >
          <Plus className="h-4 w-4" />
          Add Container
        </button>
      </div>

      {/* ── Summary cards ── */}
      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="rounded-2xl bg-white p-4 shadow-sm">
          <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Containers</p>
          <p className="mt-1 text-2xl font-bold text-gray-800">{containers.length}</p>
        </div>
        <div className="rounded-2xl bg-white p-4 shadow-sm">
          <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Total Invested</p>
          <p className="mt-1 text-2xl font-bold text-gray-800">{formatPeso(summary.totalCost)}</p>
        </div>
        <div className="rounded-2xl bg-white p-4 shadow-sm">
          <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Total Revenue</p>
          <p className="mt-1 text-2xl font-bold text-blue-600">{formatPeso(summary.totalRevenue)}</p>
        </div>
        <div className="rounded-2xl bg-white p-4 shadow-sm">
          <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Net Profit</p>
          <p
            className={`mt-1 text-2xl font-bold ${
              summary.totalProfit > 0 ? 'text-green-600' : summary.totalProfit < 0 ? 'text-red-500' : 'text-gray-500'
            }`}
          >
            {summary.totalProfit >= 0 ? '+' : ''}{formatPeso(summary.totalProfit)}
          </p>
        </div>
      </div>

      {/* ── Filters ── */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search containers…"
            className="w-full rounded-xl border border-gray-200 bg-white py-2 pl-9 pr-3 text-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm focus:border-blue-400 focus:outline-none"
        >
          <option value="all">All Statuses</option>
          <option value="Active">Active</option>
          <option value="Partially Sold">Partially Sold</option>
          <option value="Sold Out">Sold Out</option>
        </select>
      </div>

      {/* ── Content ── */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-gray-200 bg-white py-16 text-center">
          <Package2 className="h-12 w-12 text-gray-200" />
          <p className="font-medium text-gray-400">
            {containers.length === 0 ? 'No containers yet.' : 'No containers match your search.'}
          </p>
          {containers.length === 0 && (
            <button
              onClick={openAdd}
              className="mt-1 flex items-center gap-1.5 rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              <Plus className="h-4 w-4" />
              Add your first container
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((c) => (
            <ContainerCard
              key={c.id}
              container={c}
              inventory={inventory}
              sales={sales}
              onEdit={() => openEdit(c)}
            />
          ))}
        </div>
      )}

      <ContainerModal
        isOpen={modalOpen}
        onClose={() => { setModalOpen(false); setEditingContainer(null) }}
        onSubmit={handleSave}
        initialValues={editingContainer ?? undefined}
        submitting={saving}
      />
    </div>
  )
}
