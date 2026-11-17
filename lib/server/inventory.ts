// Server-side inventory operations - creates items, logs stock changes, retrieves user info
import { FieldValue, type DocumentReference } from 'firebase-admin/firestore'
import { gradeSummary } from '@/lib/inventory/units'
import { getAdminDb } from '@/lib/firebaseAdmin'
import { createItemBarcode } from '@/lib/server/barcodes'
import { normalizeStockLogActionForStorage, ResolvedStockLogAction } from '@/lib/inventory/stockLogActions'
import { InventoryCondition, getStockStatus, normalizeInventoryCondition, toNumber } from '@/lib/server/salesInventoryMetrics'
import { normalizeTrackingMode, type TrackingMode, type UnitDetails } from '@/lib/inventory/units'
import { allocateUnitCodes, writeNewUnits } from '@/lib/server/units'
import { verifiedUid } from '@/lib/server/authorize'

export type StockLogAction = Exclude<ResolvedStockLogAction, 'unmapped_action'>

// Info about who processed a transaction (user name, email, Firebase ID)
export interface ProcessedByInfo {
  uid?: string
  name: string
  email?: string
}

export interface InventoryVariant {
  id: string
  ref: DocumentReference
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
  isSingleItem: boolean
  conditionNotes: string
  /** 'unit' when each piece has its own record - see lib/inventory/units.ts. */
  trackingMode: TrackingMode
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
  /** Unit-tracked items: the exact pieces this movement involved. */
  units?: Array<{ id: string; unitCode: string; grade?: string }>
}

// Helper: Normalize item name for comparison (trim, lowercase, single spaces)
const normalizeName = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase()

// Helper: Build human-readable summary of inventory state
const buildValueSummary = (input: {
  stock: number
  reserved: number
  quantity: number
  condition: string
}) => {
  const available = Math.max(0, input.stock - input.reserved)
  return `Stock: ${input.stock} | Reserved: ${input.reserved} | Available: ${available} | Qty: ${input.quantity} | Condition: ${input.condition}`
}

// Who is doing this: the signed-in account behind the request's ID token.
//
// This used to read { uid, name, email } from the request body, so a caller
// could record a sale, a stock change or a reservation under anyone's name -
// the audit trail was only as honest as the browser. The uid now comes from the
// verified token and the name and email from that user's record.
export const getProcessedByInfo = async (req: Request): Promise<ProcessedByInfo> => {
  const uid = await verifiedUid(req)
  if (!uid) return { name: 'System User' }
  try {
    const snap = await getAdminDb().collection('users').doc(uid).get()
    const data = (snap.exists ? snap.data() : {}) as Record<string, unknown>
    const email = typeof data.email === 'string' && data.email.trim() ? data.email.trim() : undefined
    const name = (typeof data.name === 'string' && data.name.trim()) || email || 'Staff'
    return { uid, name, email }
  } catch (error) {
    console.error('Failed to resolve the signed-in user:', error)
    return { uid, name: 'Staff' }
  }
}

// The signed-in caller, who must be an administrator.
export const assertAdminUser = async (req: Request): Promise<ProcessedByInfo> => {
  const processedBy = await getProcessedByInfo(req)
  if (!processedBy.uid) throw new Error('ADMIN_REQUIRED')
  const userSnapshot = await getAdminDb().collection('users').doc(processedBy.uid).get()
  if (!userSnapshot.exists || (userSnapshot.data() as Record<string, unknown>).role !== 'admin') {
    throw new Error('ADMIN_REQUIRED')
  }
  return processedBy
}

export const findInventoryVariantById = async (id: string) => {
  const directRef = getAdminDb().collection('inventory').doc(id)
  const directSnapshot = await directRef.get()

  if (directSnapshot.exists) {
    const data = directSnapshot.data() as Record<string, unknown>
    return parseInventoryVariant(directSnapshot.id, data)
  }

  const fallbackSnapshot = await getAdminDb().collection('inventory').where('id', '==', id).get()

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
  const duplicateSnapshot = await getAdminDb()
    .collection('inventory')
    .where('categoryId', '==', params.categoryId)
    .where('status', '==', params.condition)
    .get()
  const match = duplicateSnapshot.docs.find((docItem) => {
    const data = docItem.data() as Record<string, unknown>
    return (
      data.isDeleted !== true &&
      // A single item is one specific unit, never a stock line to add to.
      // Without this, adding 3 ordinary rice cookers would raise the count on
      // a one-off unit with its own condition and price.
      data.isSingleItem !== true &&
      normalizeName(typeof data.name === 'string' ? data.name : '') === normalizeName(params.name)
    )
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
  // Per-piece items: the condition of the pieces that moved ("Good ×2, Fair"),
  // not the item's derived New/Refurbished label.
  const unitGrades = (entry.units ?? []).map((u) => u.grade ?? '').filter(Boolean)
  const condition = unitGrades.length > 0 ? gradeSummary(unitGrades) : entry.condition

  // Validate action type
  if (!actionType) {
    throw new Error(`INVALID_STOCK_LOG_ACTION:${String(entry.actionType)}`)
  }

  // Step 1: Save log entry to stockLogs collection
  await getAdminDb().collection('stockLogs').add({
    createdAt: FieldValue.serverTimestamp(),
    actionType,
    itemId: entry.itemId,
    itemName: entry.itemName,
    condition,
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
        condition,
      }),
    newValue:
      entry.newValue ??
      buildValueSummary({
        stock: stockAfter,
        reserved: reservedAfter,
        quantity: entry.quantityAfter,
        condition,
      }),
    userName: entry.user.name,
    userEmail: entry.user.email ?? '',
    userId: entry.user.uid ?? '',
    remarks: entry.remarks ?? '',
    relatedId: entry.relatedId ?? '', // Links to sale/reservation if applicable
    // Lets one unit's history be read back with array-contains on unitIds.
    ...(entry.units && entry.units.length > 0
      ? { unitIds: entry.units.map((u) => u.id), unitCodes: entry.units.map((u) => u.unitCode), ...(unitGrades.length ? { unitGrades } : {}) }
      : {}),
  })
}

const parseInventoryVariant = (id: string, data: Record<string, unknown>): InventoryVariant => {
  const ref = getAdminDb().collection('inventory').doc(id)
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
    isSingleItem: data.isSingleItem === true,
    conditionNotes: typeof data.conditionNotes === 'string' ? data.conditionNotes : '',
    trackingMode: normalizeTrackingMode(data.trackingMode),
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
  const existing = await getAdminDb()
    .collection('inventory')
    .where('sku', '>=', `${prefix}-`)
    .where('sku', '<', `${prefix}-￿`)
    .get()
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
  /** One physical unit, tracked on its own. Quantity is always 1. */
  isSingleItem?: boolean
  conditionNotes?: string
  /** 'unit' (default) gives every piece its own record; 'quantity' keeps a count only. */
  trackingMode?: TrackingMode
  /** Grade, notes and optional price for the pieces being created. */
  unitDetails?: UnitDetails
  /** Stock-log/unit source label, e.g. 'item_added'. */
  source?: string
}) => {
  const now = new Date().toISOString()
  const stockStatus = getStockStatus({ stock: input.quantity, minStock: input.minStock })
  const sku = await generateSku(input.categoryName, input.condition)
  // Short scannable code, one per variant. See lib/server/barcodes.ts.
  const barcode = await createItemBarcode()
  // A single item is one piece, so it is always unit-tracked.
  const trackingMode: TrackingMode = input.isSingleItem ? 'unit' : (input.trackingMode ?? 'unit')
  // Reserved before the transaction - the counter has a transaction of its own.
  const unitCodes = trackingMode === 'unit' ? await allocateUnitCodes(input.quantity) : []

  // Step 1: Create the inventory document and, for unit tracking, one unit per
  // piece - in one transaction, so an item never exists without its units.
  const docRef = getAdminDb().collection('inventory').doc()
  let units: ReturnType<typeof writeNewUnits> = []
  await getAdminDb().runTransaction(async (txn) => {
    txn.set(docRef, {
    id: docRef.id,
    trackingMode,
    name: input.name,
    categoryId: input.categoryId,
    categoryName: input.categoryName,
    category: input.categoryName,
    price: input.price,
    quantity: input.quantity,
    stock: input.quantity,
    reservedStock: 0,
    barcode,
    minStock: input.minStock,
    condition: input.condition,
    status: input.condition,
    sku,
    description: input.description ?? '',
    imageUrl: input.imageUrl ?? '',
    isSingleItem: input.isSingleItem === true,
    conditionNotes: input.conditionNotes ?? '',
    stockStatus,
    isDeleted: false,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
    })
    units = unitCodes.length > 0
      ? writeNewUnits(txn, {
          itemId: docRef.id,
          itemName: input.name,
          codes: unitCodes,
          details: input.isSingleItem
            ? { ...input.unitDetails, conditionNotes: input.unitDetails?.conditionNotes || input.conditionNotes }
            : input.unitDetails,
          nowIso: now,
          source: input.source ?? 'item_added',
        })
      : []
  })

  return {
    id: docRef.id,
    stockStatus,
    now,
    trackingMode,
    units,
  }
}
