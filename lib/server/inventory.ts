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
import { normalizeStockLogActionForStorage, ResolvedStockLogAction } from '@/lib/stockLogActions'
import { InventoryCondition, getStockStatus, normalizeInventoryCondition, toNumber } from '@/lib/server/salesInventoryMetrics'

export type StockLogAction = Exclude<ResolvedStockLogAction, 'unmapped_action'>

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

const normalizeName = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase()

const buildValueSummary = (input: {
  stock: number
  reserved: number
  quantity: number
  condition: InventoryCondition
}) => {
  const available = Math.max(0, input.stock - input.reserved)
  return `Stock: ${input.stock} | Reserved: ${input.reserved} | Available: ${available} | Qty: ${input.quantity} | Condition: ${input.condition}`
}

export const getProcessedByInfo = async (input: unknown): Promise<ProcessedByInfo> => {
  const fallback = { name: 'System User' }

  if (!input || typeof input !== 'object') {
    return fallback
  }

  const data = input as Record<string, unknown>
  const uid = typeof data.uid === 'string' && data.uid.trim() ? data.uid.trim() : ''
  const providedName = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : ''
  const providedEmail = typeof data.email === 'string' && data.email.trim() ? data.email.trim() : ''

  if (!uid) {
    return {
      name: providedName || providedEmail || fallback.name,
      email: providedEmail || undefined,
    }
  }

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

export const assertAdminUser = async (input: unknown): Promise<ProcessedByInfo> => {
  const processedBy = await getProcessedByInfo(input)

  if (!processedBy.uid) {
    throw new Error('ADMIN_REQUIRED')
  }

  const userSnapshot = await getDoc(doc(db, 'users', processedBy.uid))
  if (!userSnapshot.exists()) {
    throw new Error('ADMIN_REQUIRED')
  }

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

export const createStockLog = async (entry: StockLogEntryInput) => {
  const stockBefore = entry.stockBefore ?? entry.quantityBefore
  const stockAfter = entry.stockAfter ?? entry.quantityAfter
  const reservedBefore = entry.reservedBefore ?? 0
  const reservedAfter = entry.reservedAfter ?? 0
  const actionType = normalizeStockLogActionForStorage(entry.actionType)

  if (!actionType) {
    throw new Error(`INVALID_STOCK_LOG_ACTION:${String(entry.actionType)}`)
  }

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
    relatedId: entry.relatedId ?? '',
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
    data,
  }
}

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
    status: input.condition,
    description: input.description ?? '',
    imageUrl: input.imageUrl ?? '',
    stockStatus,
    isDeleted: false,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  })

  await runTransaction(db, async (transaction) => {
    transaction.update(docRef, { id: docRef.id })
  })

  return {
    id: docRef.id,
    stockStatus,
    now,
  }
}
