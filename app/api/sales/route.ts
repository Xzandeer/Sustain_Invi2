// Sales API endpoint - POST to create sales, GET to list sales
import { NextRequest, NextResponse } from 'next/server'
import { collection, doc, getDocs, query, runTransaction, serverTimestamp, addDoc } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import {
  createStockLog,
  findInventoryVariantById,
  getProcessedByInfo,
} from '@/lib/server/inventory'
import { createTransactionNumber } from '@/lib/server/transactionNumbers'
import { getWarrantyDays } from '@/lib/server/storeSettings'
import { parseDateRange, toDate, toNumber } from '@/lib/server/salesInventoryMetrics'
import {
  SALES_THANK_YOU_NOTE,
  STORE_NAME,
  STORE_TAGLINE,
  TransactionLineItem,
  SaleReceiptDocument,
  ReceiptRecord,
} from '@/lib/transactions/transactionDocuments'

interface SalesPayload {
  itemId?: unknown
  quantity?: unknown
  items?: unknown
  customer?: unknown
  customerDetails?: unknown
  processedBy?: unknown
  reduceQuantity?: unknown
}

interface CustomerDetails {
  fullName: string
  email: string
  contactNumber: string
}

// Helper: Validate and parse customer information
const parseCustomerDetails = (input: unknown): CustomerDetails | null => {
  if (!input || typeof input !== 'object') return null

  const data = input as Record<string, unknown>
  const fullName = typeof data.fullName === 'string' ? data.fullName.trim() : ''
  const email = typeof data.email === 'string' ? data.email.trim() : ''
  const contactNumber = typeof data.contactNumber === 'string' ? data.contactNumber.trim() : ''

  return { fullName, email, contactNumber }
}

// GET /api/sales - List sales with optional filtering by date and category
export async function GET(req: NextRequest) {
  try {
    // Step 1: Parse query parameters
    const { searchParams } = new URL(req.url)
    const startDate = searchParams.get('startDate')
    const endDate = searchParams.get('endDate')
    const categoryName = searchParams.get('category')

    // Step 2: Validate date range
    const range = parseDateRange(startDate, endDate)
    if ('error' in range) {
      return NextResponse.json({ error: range.error }, { status: 400 })
    }

    // Step 3: Fetch all sales from database
    const snapshot = await getDocs(collection(db, 'sales'))

    let records: Array<Record<string, unknown> & { id: string }> = snapshot.docs.map((saleDoc) => ({
      ...(saleDoc.data() as Record<string, unknown>),
      id: saleDoc.id,
    }))

    // Step 4: Filter by category if specified
    if (categoryName && categoryName !== 'all') {
      records = records.filter((record) => record.categoryName === categoryName || record.category === categoryName)
    }

    // Step 5: Filter by date range if specified
    if (range.start || range.end) {
      records = records.filter((record) => {
        const recordDate = toDate(record.createdAt)
        if (!recordDate) return false
        if (range.start && recordDate < range.start) return false
        if (range.end && recordDate > range.end) return false
        return true
      })
    }

    // Step 6: Sort by most recent first
    records.sort((a, b) => {
      const aDate = toDate(a.createdAt)?.getTime() ?? 0
      const bDate = toDate(b.createdAt)?.getTime() ?? 0
      return bDate - aDate
    })

    return NextResponse.json({ data: records }, { status: 200 })
  } catch (error) {
    console.error('GET /api/sales error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

// POST /api/sales - Create a new sale, reduce inventory, and generate receipt
export async function POST(req: NextRequest) {
  try {
    // Step 1: Parse request body
    const body = (await req.json()) as SalesPayload
    const customerDetails = parseCustomerDetails(body.customerDetails)
    const processedBy = await getProcessedByInfo(body.processedBy)
    const reduceQuantity = body.reduceQuantity !== false
    const payloadItems = Array.isArray(body.items)
      ? body.items
      : typeof body.itemId === 'string'
        ? [{ itemId: body.itemId, quantity: body.quantity }]
        : []

    // Step 2: Parse customer details (all fields optional)
    if (!customerDetails) {
      return NextResponse.json(
        { error: 'Invalid customer details.' },
        { status: 400 }
      )
    }

    // Step 3: Normalize and validate items (ensure itemId and quantity are valid)
    const normalizedItems = payloadItems
      .map((item) => {
        const record = item as Record<string, unknown>
        const itemId = typeof record.itemId === 'string' ? record.itemId.trim() : ''
        const quantity = Math.floor(toNumber(record.quantity, Number.NaN))
        return { itemId, quantity }
      })
      .filter((item) => item.itemId && Number.isFinite(item.quantity) && item.quantity > 0)

    // Step 4: Merge duplicate items (if same itemId appears multiple times, combine quantities)
    const mergedItems = Array.from(
      normalizedItems.reduce<Map<string, { itemId: string; quantity: number }>>((result, item) => {
        const existing = result.get(item.itemId)
        if (existing) {
          existing.quantity += item.quantity
        } else {
          result.set(item.itemId, { itemId: item.itemId, quantity: item.quantity })
        }

        return result
      }, new Map()).values()
    )

    // Step 5: Require at least one valid item
    if (mergedItems.length === 0) {
      return NextResponse.json({ error: 'Add at least one valid item to continue.' }, { status: 400 })
    }

    // Step 6: Check current time
    const now = new Date()
    const nowIso = now.toISOString()

    // Step 7: Fetch inventory items and validate they exist
    const preparedItems = await Promise.all(
      mergedItems.map(async (requestedItem) => {
        const inventoryItem = await findInventoryVariantById(requestedItem.itemId)
        if (!inventoryItem || inventoryItem.isDeleted) {
          throw new Error('ITEM_NOT_FOUND')
        }
        if (inventoryItem.isVoided) {
          throw new Error('ITEM_VOIDED')
        }
        return {
          requestedItem,
          inventoryItem,
        }
      })
    )

    // Step 8: Prepare to track sale line items
    const saleLines: Array<{
      itemId: string
      name: string
      quantity: number
      price: number
      categoryId: string
      categoryName: string
      condition: string
      stockBefore: number
      stockAfter: number
      reservedBefore: number
      reservedAfter: number
    }> = []

    // Step 9: Atomic transaction - check stock and reduce quantities
    await runTransaction(db, async (transaction) => {
      const pendingUpdates: Array<{
        ref: typeof preparedItems[number]['inventoryItem']['ref']
        nextStock: number
      }> = []

      // Loop through each item in sale
      for (const { requestedItem, inventoryItem } of preparedItems) {
        const inventorySnapshot = await transaction.get(inventoryItem.ref)
        if (!inventorySnapshot.exists()) {
          throw new Error('ITEM_NOT_FOUND')
        }

        // Get current stock and reserved amounts
        const latestData = inventorySnapshot.data() as Record<string, unknown>
        const currentStock = Math.max(0, toNumber(latestData.stock ?? latestData.quantity, 0))
        const currentReservedStock = Math.max(0, toNumber(latestData.reservedStock, 0))
        const availableStock = Math.max(0, currentStock - currentReservedStock)

        // Check sufficient stock available (after reservations)
        if (requestedItem.quantity > availableStock) {
          throw new Error('INSUFFICIENT_STOCK')
        }

        const nextStock = currentStock - requestedItem.quantity
        pendingUpdates.push({
          ref: inventoryItem.ref,
          nextStock,
        })

        // Record this line item for the sale
        saleLines.push({
          itemId: inventoryItem.id,
          name: inventoryItem.name,
          quantity: requestedItem.quantity,
          price: inventoryItem.price,
          categoryId: inventoryItem.categoryId,
          categoryName: inventoryItem.categoryName,
          condition: inventoryItem.condition,
          stockBefore: currentStock,
          stockAfter: nextStock,
          reservedBefore: currentReservedStock,
          reservedAfter: currentReservedStock,
        })
      }

      // Only reduce inventory if reduceQuantity flag is true
      if (!reduceQuantity) {
        return
      }

      // Apply all inventory updates atomically
      for (const update of pendingUpdates) {
        transaction.update(update.ref, {
          quantity: update.nextStock,
          stock: update.nextStock,
          updatedAt: nowIso,
        })
      }
    })

    // Step 10: Calculate total amount and get unique categories
    const totalAmount = saleLines.reduce((sum, item) => sum + item.quantity * item.price, 0)
    const categoryNames = Array.from(new Set(saleLines.map((item) => item.categoryName)))

    // Snapshot the store's warranty policy onto this sale
    const saleWarrantyDays = await getWarrantyDays()

    // Step 11: Create sale document reference and generate unique receipt number
    const saleRef = doc(collection(db, 'sales'))
    const numberResult = await createTransactionNumber('sale', saleRef, (numberInfo) => ({
      ...(saleLines.length === 1 ? { itemId: saleLines[0].itemId } : {}),
      id: saleRef.id,
      receiptNumber: numberInfo.value,
      transactionType: 'sale',
      dateKey: numberInfo.dateKey,
      sequenceNumber: numberInfo.sequenceNumber,
      searchableNumber: numberInfo.value,
      customerSearchEmail: customerDetails.email.toLowerCase(),
      items: saleLines.map((item) => ({
        itemId: item.itemId,
        name: item.name,
        quantity: item.quantity,
        price: item.price,
        categoryId: item.categoryId,
        categoryName: item.categoryName,
        condition: item.condition,
        warrantyDays: saleWarrantyDays,
        status: 'completed',
      })),
      categoryName: categoryNames.join(', '),
      category: categoryNames.join(', '),
      customer: customerDetails.fullName,
      customerName: customerDetails.fullName,
      customerEmail: customerDetails.email,
      customerContactNumber: customerDetails.contactNumber,
      totalAmount,
      quantity: saleLines.reduce((sum, item) => sum + item.quantity, 0),
      total: totalAmount,
      amount: totalAmount,
      status: 'Completed',
      // Snapshot of the store policy on the day of sale — the refund window
      // promised to this customer, even if the policy changes later.
      warrantyDays: saleWarrantyDays,
      processedByName: processedBy.name,
      processedByEmail: processedBy.email ?? '',
      createdAt: serverTimestamp(),
      transactionDate: nowIso,
    }), nowIso)

    await Promise.all(
      [
        ...saleLines.map((item) =>
          createStockLog({
            actionType: 'sale_deduction',
            itemId: item.itemId,
            itemName: item.name,
            condition: item.condition === 'Refurbished' ? 'Refurbished' : 'New',
            quantityBefore: item.stockBefore,
            quantityChanged: item.quantity * -1,
            quantityAfter: item.stockAfter,
            stockBefore: item.stockBefore,
            stockAfter: item.stockAfter,
            reservedBefore: item.reservedBefore,
            reservedAfter: item.reservedAfter,
            user: processedBy,
            relatedId: saleRef.id,
            remarks: `Sale ${numberResult.value} completed.`,
          })
        ),
      ]
    )

    const receiptItems: TransactionLineItem[] = saleLines.map((item) => ({
      itemId: item.itemId,
      name: item.name,
      quantity: item.quantity,
      price: item.price,
      categoryName: item.categoryName,
      condition: item.condition,
      subtotal: item.quantity * item.price,
    }))

    const receiptDocument: SaleReceiptDocument = {
      type: 'sale',
      receiptNumber: numberResult.value,
      storeName: STORE_NAME,
      storeTagline: STORE_TAGLINE,
      customer: customerDetails,
      items: receiptItems,
      totalAmount,
      transactionDate: nowIso,
      processedBy: processedBy.name,
      note: SALES_THANK_YOU_NOTE,
    }


    const receiptRecord: ReceiptRecord = {
      id: saleRef.id,
      receiptNumber: numberResult.value,
      transactionType: 'sale',
      transactionId: saleRef.id,
      customerName: customerDetails.fullName,
      contactNumber: customerDetails.contactNumber,
      items: receiptItems,
      subtotal: totalAmount,
      discount: 0,
      total: totalAmount,
      cashierName: processedBy.name,
      createdAt: nowIso,
      status: 'active',
      document: receiptDocument,
    }

    await addDoc(collection(db, 'receipts'), receiptRecord)

    return NextResponse.json(
      {
        data: {
          id: saleRef.id,
          receiptNumber: numberResult.value,
          items: receiptItems,
          totalAmount,
          createdAt: nowIso,
          customer: customerDetails.fullName,
        },
        document: receiptDocument,
        receipt: receiptRecord,
      },
      { status: 201 }
    )
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === 'INSUFFICIENT_STOCK') {
        return NextResponse.json({ error: 'Cannot sell more than available stock.' }, { status: 400 })
      }

      if (error.message === 'ITEM_VOIDED') {
        return NextResponse.json({ error: 'One or more items have been voided and cannot be sold.' }, { status: 400 })
      }
      if (error.message === 'ITEM_NOT_FOUND') {
        return NextResponse.json({ error: 'One or more selected items were not found.' }, { status: 404 })
      }

      console.error('SALE ERROR:', error)
      return NextResponse.json({ error: error.message || 'Server error' }, { status: 500 })
    }

    console.error('SALE ERROR:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
