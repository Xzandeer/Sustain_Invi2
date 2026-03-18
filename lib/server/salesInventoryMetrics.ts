export interface InventoryRecord {
  id?: string
  name?: string
  category?: string
  categoryId?: string
  categoryName?: string
  status?: string
  stockStatus?: string
  stock?: number | string
  quantity?: number | string
  minStock?: number | string
  isDeleted?: boolean
}

export interface SaleRecord {
  id?: string
  items?: Array<{
    name?: string
    quantity?: number | string
    price?: number | string
    categoryId?: string
    status?: string
  }>
  category?: string
  categoryName?: string
  totalAmount?: number | string
  amount?: number | string
  total?: number | string
  quantity?: number | string
  price?: number | string
  saleDate?: unknown
  date?: unknown
  createdAt?: unknown
  timestamp?: unknown
}

export interface DashboardMetrics {
  totalSales: number
  itemsSold: number
  productsInStock: number
  lowStockItems: LowStockItem[]
  outOfStockItems: number
}

export interface LowStockItem {
  id: string
  name: string
  categoryName: string
  stock: number
}

export type InventoryCondition = 'New' | 'Refurbished'
export type StockStatus = 'Available' | 'Low Stock' | 'Out of Stock'

const DAY_MS = 24 * 60 * 60 * 1000

export const toNumber = (value: unknown, fallback = 0): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

export const toDate = (value: unknown): Date | null => {
  if (!value) return null

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value
  }

  if (typeof value === 'object') {
    const maybeTimestamp = value as { toDate?: () => Date; seconds?: number; nanoseconds?: number }

    if (typeof maybeTimestamp.toDate === 'function') {
      const parsed = maybeTimestamp.toDate()
      return Number.isNaN(parsed.getTime()) ? null : parsed
    }

    if (typeof maybeTimestamp.seconds === 'number') {
      const millis =
        maybeTimestamp.seconds * 1000 + Math.floor((maybeTimestamp.nanoseconds ?? 0) / 1_000_000)
      const parsed = new Date(millis)
      return Number.isNaN(parsed.getTime()) ? null : parsed
    }
  }

  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? null : parsed
  }

  return null
}

export const parseDateRange = (startDate?: string | null, endDate?: string | null) => {
  const start = startDate ? new Date(startDate) : null
  const endBase = endDate ? new Date(endDate) : null

  if (start && Number.isNaN(start.getTime())) return { error: 'Invalid startDate' as const }
  if (endBase && Number.isNaN(endBase.getTime())) return { error: 'Invalid endDate' as const }

  if (start && endBase && endBase.getTime() < start.getTime()) {
    return { error: 'End date cannot be earlier than start date.' as const }
  }

  const end = endBase ? new Date(endBase.getTime() + DAY_MS - 1) : null
  return { start, end }
}

export const getInventoryStatus = (quantityRaw: unknown, minStockRaw: unknown) => {
  const quantity = toNumber(quantityRaw)
  const minStock = toNumber(minStockRaw)

  if (quantity <= 0) return 'Out of Stock'
  if (quantity <= minStock) return 'Low Stock'
  return 'Available'
}

export const normalizeInventoryCondition = (value: unknown): InventoryCondition => {
  return value === 'Refurbished' ? 'Refurbished' : 'New'
}

export const getStockStatus = (item: {
  stock?: unknown
  quantity?: unknown
  minStock?: unknown
}): StockStatus => {
  const stock = toNumber(item.stock ?? item.quantity, 0)
  const minStock = toNumber(item.minStock, 0)

  if (stock === 0) return 'Out of Stock'
  if (stock <= minStock) return 'Low Stock'
  return 'Available'
}

export const getSaleDate = (sale: SaleRecord): Date | null => {
  return (
    toDate(sale.date) ??
    toDate(sale.saleDate) ??
    toDate(sale.createdAt) ??
    toDate(sale.timestamp) ??
    null
  )
}

export const computeTotalSales = (sales: SaleRecord[]) => {
  return sales.reduce((sum, sale) => {
    return sum + toNumber(sale.totalAmount, toNumber(sale.total, toNumber(sale.amount)))
  }, 0)
}

export const computeItemsSold = (sales: SaleRecord[]) => {
  return sales.reduce((count, sale) => {
    const itemCount = Array.isArray(sale.items)
      ? sale.items.reduce((itemSum, item) => itemSum + Math.max(0, toNumber(item.quantity, 0)), 0)
      : Math.max(0, toNumber(sale.quantity, 0))
    return count + itemCount
  }, 0)
}

export const computeProductsInStock = (inventory: InventoryRecord[]) => {
  return inventory.reduce((sum, item) => sum + Math.max(0, toNumber(item.quantity)), 0)
}

export const computeLowStockItems = (inventory: InventoryRecord[]) => {
  return inventory
    .filter((item) => toNumber(item.quantity) <= toNumber(item.minStock))
    .map((item) => ({
      id: item.id?.trim() || 'unknown-item',
      name: item.name?.trim() || item.id?.trim() || 'Unnamed Item',
      categoryName: item.categoryName?.trim() || item.category?.trim() || 'Uncategorized',
      stock: toNumber(item.quantity),
    }))
}

export const computeOutOfStockItems = (inventory: InventoryRecord[]) => {
  return inventory.filter((item) => toNumber(item.quantity) === 0).length
}

export const computeDashboardMetrics = (
  sales: SaleRecord[],
  inventory: InventoryRecord[]
): DashboardMetrics => {
  return {
    totalSales: computeTotalSales(sales),
    itemsSold: computeItemsSold(sales),
    productsInStock: computeProductsInStock(inventory),
    lowStockItems: computeLowStockItems(inventory),
    outOfStockItems: computeOutOfStockItems(inventory),
  }
}
