// Server-side inventory operations - creates items, logs stock changes, retrieves user info
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  runTransaction,
  serverTimestamp,
  where,
} from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { normalizeStockLogActionForStorage, ResolvedStockLogAction } from '@/lib/inventory/stockLogActions'
import { InventoryCondition, getStockStatus, normalizeInventoryCondition, toNumber } from '@/lib/server/salesInventoryMetrics'

export type StockLogAction = Exclude<ResolvedStockLogAction, 'unmapped_action'>

// Info about who processed a transaction (user name, email, Firebase ID)
export interface ProcessedByInfo {
  uid?: string
  name: string
  email?: string
}

export interface InventoryVariant {
  id: string
  ref: ReturnType<typeof doc>
  name: string
  categoryId: string
  categoryName: string
  price: number
  stock: number
  reservedStock: number
  minStock: number
  condition: InventoryCondition
  isDeleted: boolean
  isVoided: boolean
  data: Record<string, unknown>
}

export interface StockLogEntryInput {
  actionType: StockLogAction
  itemId: string
  itemName: string
  condition: InventoryCondition
  quantityBefore: number
  quantityChanged: number
  quantityAfter: number
  user: ProcessedByInfo
  remarks?: string
  stockBefore?: number
  stockAfter?: number
  reservedBefore?: number
  reservedAfter?: number
  relatedId?: string
  previousValue?: string
  newValue?: string
}

// Helper: Normalize item name for comparison (trim, lowercase, single spaces)
const normalizeName = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase()

// Helper: Build human-readable summary of inventory state
const buildValueSummary = (input: {
  stock: number
  reserved: number
  quantity: number
  condition: InventoryCondition
}) => {
  const available = Math.max(0, input.stock - input.reserved)
  return `Stock: ${input.stock} | Reserved: ${input.reserved} | Available: ${available} | Qty: ${input.quantity} | Condition: ${input.condition}`
}

// Get user info from Firebase or fallback to provided data
export const getProcessedByInfo = async (input: unknown): Promise<ProcessedByInfo> => {
  const fallback = { name: 'System User' }

  if (!input || typeof input !== 'object') {
    return fallback
  }

  const data = input as Record<string, unknown>
  const uid = typeof data.uid === 'string' && data.uid.trim() ? data.uid.trim() : ''
  const providedName = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : ''
  const providedEmail = typeof data.email === 'string' && data.email.trim() ? data.email.trim() : ''

  // No UID means we can't look up user, use provided data
  if (!uid) {
    return {
      name: providedName || providedEmail || fallback.name,
      email: providedEmail || undefined,
    }
  }

  // Try to get full user details from users collection
  try {
    const userSnapshot = await getDoc(doc(db, 'users', uid))
    if (userSnapshot.exists()) {
      const userData = userSnapshot.data() as Record<string, unknown>
      const name =
        (typeof userData.name === 'string' && userData.name.trim()) ||
        providedName ||
        (typeof userData.email === 'string' && userData.email.trim()) ||
        providedEmail ||
        fallback.name
      const email =
        (typeof userData.email === 'string' && userData.email.trim()) || providedEmail || undefined

      return { uid, name, email }
    }
  } catch (error) {
    console.error('Failed to resolve processed by user:', error)
  }

  return {
    uid,
    name: providedName || providedEmail || fallback.name,
    email: providedEmail || undefined,
  }
}

// Verify user is admin, throw error if not
export const assertAdminUser = async (input: unknown): Promise<ProcessedByInfo> => {
  const processedBy = await getProcessedByInfo(input)

  // Step 1: Check user has UID (not anonymous)
  if (!processedBy.uid) {
    throw new Error('ADMIN_REQUIRED')
  }

  // Step 2: Get user document from Firebase
  const userSnapshot = await getDoc(doc(db, 'users', processedBy.uid))
  if (!userSnapshot.exists()) {
    throw new Error('ADMIN_REQUIRED')
  }

  // Step 3: Verify role is 'admin'
  const userData = userSnapshot.data() as Record<string, unknown>
  if (userData.role !== 'admin') {
    throw new Error('ADMIN_REQUIRED')
  }

  return processedBy
}

export const findInventoryVariantById = async (id: string) => {
  const directRef = doc(db, 'inventory', id)
  const directSnapshot = await getDoc(directRef)

  if (directSnapshot.exists()) {
    const data = directSnapshot.data() as Record<string, unknown>
    return parseInventoryVariant(directSnapshot.id, data)
  }

  const fallbackQuery = query(collection(db, 'inventory'), where('id', '==', id))
  const fallbackSnapshot = await getDocs(fallbackQuery)

  if (fallbackSnapshot.empty) {
    return null
  }

  const fallbackDoc = fallbackSnapshot.docs[0]
  return parseInventoryVariant(fallbackDoc.id, fallbackDoc.data() as Record<string, unknown>)
}

export const findInventoryVariant = async (params: {
  name: string
  categoryId: string
  condition: InventoryCondition
}) => {
  const duplicateQuery = query(
    collection(db, 'inventory'),
    where('categoryId', '==', params.categoryId),
    where('status', '==', params.condition)
  )

  const duplicateSnapshot = await getDocs(duplicateQuery)
  const match = duplicateSnapshot.docs.find((docItem) => {
    const data = docItem.data() as Record<string, unknown>
    return data.isDeleted !== true && normalizeName(typeof data.name === 'string' ? data.name : '') === normalizeName(params.name)
  })

  if (!match) return null
  return parseInventoryVariant(match.id, match.data() as Record<string, unknown>)
}

// Create stock log entry to track inventory changes (audit trail)
export const createStockLog = async (entry: StockLogEntryInput) => {
  // Normalize stock values (use provided or fall back to quantity)
  const stockBefore = entry.stockBefore ?? entry.quantityBefore
  const stockAfter = entry.stockAfter ?? entry.quantityAfter
  const reservedBefore = entry.reservedBefore ?? 0
  const reservedAfter = entry.reservedAfter ?? 0
  const actionType = normalizeStockLogActionForStorage(entry.actionType)

  // Validate action type
  if (!actionType) {
    throw new Error(`INVALID_STOCK_LOG_ACTION:${String(entry.actionType)}`)
  }

  // Step 1: Save log entry to stockLogs collection
  await addDoc(collection(db, 'stockLogs'), {
    createdAt: serverTimestamp(),
    actionType,
    itemId: entry.itemId,
    itemName: entry.itemName,
    condition: entry.condition,
    quantityBefore: entry.quantityBefore,
    quantityChanged: entry.quantityChanged,
    quantityAfter: entry.quantityAfter,
    stockBefore,
    stockAfter,
    reservedBefore,
    reservedAfter,
    // Store human-readable summary of state before/after
    previousValue:
      entry.previousValue ??
      buildValueSummary({
        stock: stockBefore,
        reserved: reservedBefore,
        quantity: entry.quantityBefore,
        condition: entry.condition,
      }),
    newValue:
      entry.newValue ??
      buildValueSummary({
        stock: stockAfter,
        reserved: reservedAfter,
        quantity: entry.quantityAfter,
        condition: entry.condition,
      }),
    userName: entry.user.name,
    userEmail: entry.user.email ?? '',
    userId: entry.user.uid ?? '',
    remarks: entry.remarks ?? '',
    relatedId: entry.relatedId ?? '', // Links to sale/reservation if applicable
  })
}

const parseInventoryVariant = (id: string, data: Record<string, unknown>): InventoryVariant => {
  const ref = doc(db, 'inventory', id)
  return {
    id,
    ref,
    name: typeof data.name === 'string' ? data.name.trim() : '',
    categoryId: typeof data.categoryId === 'string' ? data.categoryId.trim() : '',
    categoryName:
      (typeof data.categoryName === 'string' && data.categoryName.trim()) ||
      (typeof data.category === 'string' && data.category.trim()) ||
      'Uncategorized',
    price: Math.max(0, toNumber(data.price, 0)),
    stock: Math.max(0, toNumber(data.stock ?? data.quantity, 0)),
    reservedStock: Math.max(0, toNumber(data.reservedStock, 0)),
    minStock: Math.max(0, toNumber(data.minStock, 0)),
    condition: normalizeInventoryCondition(data.condition),
    isDeleted: data.isDeleted === true,
    isVoided: data.isVoided === true,
    data,
  }
}

// ── SKU generation ─────────────────────────────────────────────────────────────
const CATEGORY_CODES: Record<string, string> = {
  'Bags': 'BAG',
  'Clothing': 'CLO',
  'Footwear': 'FTW',
  'Accessories': 'ACC',
  'Kitchenware': 'KIT',
  'Appliances': 'APP',
  'Electronics': 'ELC',
  'Furniture': 'FUR',
  'Toys': 'TOY',
  'Home Decor': 'HMD',
  'School Supplies': 'SCH',
  'Collectibles': 'COL',
}

async function generateSku(categoryName: string, condition: string): Promise<string> {
  const catCode = CATEGORY_CODES[categoryName] ?? categoryName.slice(0, 3).toUpperCase()
  const condCode = condition === 'New' ? 'N' : 'R'
  const prefix = `${catCode}-${condCode}`

  // Count existing items with same prefix to get next sequence number
  const existing = await getDocs(
    query(collection(db, 'inventory'), where('sku', '>=', `${prefix}-`), where('sku', '<', `${prefix}-￿`))
  )
  const next = existing.size + 1
  return `${prefix}-${String(next).padStart(3, '0')}`
}

// Create new inventory item/variant with initial stock
export const createInventoryVariant = async (input: {
  name: string
  categoryId: string
  categoryName: string
  price: number
  quantity: number
  minStock: number
  condition: InventoryCondition
  description?: string
  imageUrl?: string
}) => {
  const now = new Date().toISOString()
  const stockStatus = getStockStatus({ stock: input.quantity, minStock: input.minStock })
  const sku = await generateSku(input.categoryName, input.condition)

  // Step 1: Create inventory document
  const docRef = await addDoc(collection(db, 'inventory'), {
    name: input.name,
    categoryId: input.categoryId,
    categoryName: input.categoryName,
    category: input.categoryName,
    price: input.price,
    quantity: input.quantity,
    stock: input.quantity,
    reservedStock: 0,
    minStock: input.minStock,
    condition: input.condition,
    status: input.condition,
    sku,
    description: input.description ?? '',
    imageUrl: input.imageUrl ?? '',
    stockStatus,
    isDeleted: false,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  })

  // Step 2: Update document to add its own ID (for cross-references)
  await runTransaction(db, async (transaction) => {
    transaction.update(docRef, { id: docRef.id })
  })

  return {
    id: docRef.id,
    stockStatus,
    now,
  }
}
