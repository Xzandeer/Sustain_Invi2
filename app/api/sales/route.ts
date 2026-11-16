// Sales API endpoint - POST to create sales, GET to list sales
import { INPUT_LIMITS } from '@/lib/constants/limits'
import { NextRequest, NextResponse } from 'next/server'
import { FieldValue, Timestamp, type Query } from 'firebase-admin/firestore'
import { getAdminDb } from '@/lib/firebaseAdmin'
import {
  createStockLog,
  findInventoryVariantById,
  getProcessedByInfo,
} from '@/lib/server/inventory'
import { createTransactionNumber } from '@/lib/server/transactionNumbers'
import { guardRequest, requireActiveUserRequest } from '@/lib/server/authorize'
import {
  describeUnits, isUnitTracked, linesByPrice, parseItemRequests, pickUnitsForParts, readItemUnits, setUnitsStatus, unitPrice,
  type StoredUnit,
} from '@/lib/server/units'
import type { UnitLineRef } from '@/lib/inventory/units'
import { getStoreSettings } from '@/lib/server/storeSettings'
import { parseDateRange, toDate, toNumber } from '@/lib/server/salesInventoryMetrics'
import {
  SALES_THANK_YOU_NOTE,
  STORE_NAME,
  STORE_TAGLINE,
  TransactionLineItem,
  SaleReceiptDocument,
  ReceiptRecord,
} from '@/lib/transactions/transactionDocuments'

const round2 = (n: number) => Math.round(n * 100) / 100

interface SalesPayload {
  itemId?: unknown
  quantity?: unknown
  items?: unknown
  customer?: unknown
  customerDetails?: unknown
  processedBy?: unknown
  /** Peso discount on the whole sale (the cashier's discount box). */
  discount?: unknown
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
  const fullName = typeof data.fullName === 'string' ? data.fullName.trim().slice(0, INPUT_LIMITS.name) : ''
  const email = typeof data.email === 'string' ? data.email.trim().slice(0, INPUT_LIMITS.email) : ''
  const contactNumber = typeof data.contactNumber === 'string' ? data.contactNumber.trim().slice(0, 15) : ''

  return { fullName, email, contactNumber }
}

// GET /api/sales - List sales with optional filtering by date and category
export async function GET(req: NextRequest) {
  // Read access is checked here, not left to the database rules: this route
  // uses the Admin SDK, which bypasses the rules entirely. Without this line
  // the data below is returned to anyone on the internet who calls the URL.
  // Every sale with its customer's contact details and the full revenue
  // history - the same figures the dashboard shows only with View Analytics.
  const denied = await guardRequest(req, 'canViewAnalytics')
  if (denied) return denied

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

    // Step 3: Fetch sales from database
    //
    // When a date range was supplied, push it into the query instead of reading
    // the whole collection and discarding most of it in memory. Every sale
    // document stores createdAt as a Firestore Timestamp, so the comparison is
    // reliable. Without a range this still reads everything - the caller asked
    // for everything.
    let salesQuery: Query = getAdminDb().collection('sales')
    if (range.start) salesQuery = salesQuery.where('createdAt', '>=', Timestamp.fromDate(range.start))
    if (range.end) salesQuery = salesQuery.where('createdAt', '<=', Timestamp.fromDate(range.end))

    const snapshot = await salesQuery.get()

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

    // This route deducts stock and issues a numbered invoice, so it must not be
    // reachable by an anonymous caller. There is no permission to check - every
    // employee sells - only that the account exists and is still enabled.
    const uid =
      body.processedBy && typeof body.processedBy === 'object'
        ? (body.processedBy as Record<string, unknown>).uid
        : undefined
  const denied = await requireActiveUserRequest(req)
  if (denied) return denied

    const customerDetails = parseCustomerDetails(body.customerDetails)
    const processedBy = await getProcessedByInfo(req)
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

    // Steps 3-4: One entry per item. A cart can hold one item in several
    // conditions (each its own price) and scanned pieces; they stay parts of
    // that item's entry, so its count is updated once.
    const mergedItems = parseItemRequests(payloadItems)

    // Step 5: Require at least one valid item
    if (mergedItems.length === 0) {
      return NextResponse.json({ error: 'Add at least one valid item to continue.' }, { status: 400 })
    }

    // Step 5b: The discount: a peso amount, never negative, never more than the
    // cart is worth at today's prices (checked again once prices are read).
    const rawDiscount = typeof body.discount === 'number' ? body.discount : Number(body.discount ?? 0)
    if (!Number.isFinite(rawDiscount) || rawDiscount < 0) {
      return NextResponse.json({ error: 'Discount must be zero or more.' }, { status: 400 })
    }
    const requestedDiscount = round2(rawDiscount)

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
      /** Tells same-item lines apart (one per price) - refunds match on it. */
      lineKey: string
      name: string
      quantity: number
      price: number
      categoryId: string
      categoryName: string
      condition: string
      conditionNotes: string
      /** Unit-tracked items: the exact pieces sold on this line. */
      unitLines?: UnitLineRef[]
    }> = []
    // One entry per item (not per line), for its stock log.
    const stockMoves: Array<{
      itemId: string
      name: string
      condition: string
      quantity: number
      stockBefore: number
      stockAfter: number
      reservedBefore: number
      reservedAfter: number
      units: StoredUnit[]
    }> = []

    // Known before the transaction, so sold units can point at it.
    const saleRef = getAdminDb().collection('sales').doc()

    // Price by condition, read before the transaction (a read cannot sit inside one).
    const { gradePricing } = await getStoreSettings()

    // Step 9: Atomic transaction - check stock and reduce quantities
    await getAdminDb().runTransaction(async (transaction) => {
      const pendingUpdates: Array<{
        ref: typeof preparedItems[number]['inventoryItem']['ref']
        nextStock: number
        units: StoredUnit[]
      }> = []
      // A retried transaction must not repeat lines.
      saleLines.length = 0
      stockMoves.length = 0

      // Loop through each item in sale
      for (const { requestedItem, inventoryItem } of preparedItems) {
        const inventorySnapshot = await transaction.get(inventoryItem.ref)
        if (!inventorySnapshot.exists) {
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

        // Unit-tracked: per condition asked for, the scanned pieces then the
        // oldest on the shelf. Each piece sells at its condition's price (or
        // its own), so an item can make more than one line - one per price.
        const units = isUnitTracked(latestData)
          ? pickUnitsForParts(
              await readItemUnits(transaction, inventoryItem.id, 'in_stock'),
              requestedItem.parts,
              inventoryItem.name
            )
          : []

        pendingUpdates.push({
          ref: inventoryItem.ref,
          nextStock,
          units,
        })

        const base = {
          itemId: inventoryItem.id,
          name: inventoryItem.name,
          categoryId: inventoryItem.categoryId,
          categoryName: inventoryItem.categoryName,
          condition: inventoryItem.condition,
          // From the database, not the request: the sale records what the item
          // was actually described as when it left the shop, which is what a
          // refund dispute about its condition would turn on.
          conditionNotes: inventoryItem.conditionNotes,
        }
        if (units.length > 0) {
          for (const line of linesByPrice(inventoryItem.id, units, (u) => unitPrice(u, inventoryItem.price, gradePricing))) {
            saleLines.push({
              ...base,
              // New/Refurbished from these pieces' conditions, for older reports.
              condition: line.condition,
              lineKey: line.lineKey,
              quantity: line.quantity,
              price: line.price,
              unitLines: line.unitLines,
            })
          }
        } else {
          saleLines.push({ ...base, lineKey: inventoryItem.id, quantity: requestedItem.quantity, price: inventoryItem.price })
        }

        stockMoves.push({
          itemId: inventoryItem.id,
          name: inventoryItem.name,
          condition: inventoryItem.condition,
          quantity: requestedItem.quantity,
          stockBefore: currentStock,
          stockAfter: nextStock,
          reservedBefore: currentReservedStock,
          reservedAfter: currentReservedStock,
          units,
        })
      }

      // Apply all inventory updates atomically
      for (const update of pendingUpdates) {
        transaction.update(update.ref, {
          quantity: update.nextStock,
          stock: update.nextStock,
          updatedAt: nowIso,
        })
        setUnitsStatus(transaction, update.units, 'sold', nowIso, { saleId: saleRef.id })
      }
    })

    // Step 10: Totals. The discount was already checked against the subtotal
    // before any stock moved (see Step 5b).
    const subtotal = round2(saleLines.reduce((sum, item) => sum + item.quantity * item.price, 0))
    const discount = Math.min(requestedDiscount, subtotal)
    const totalAmount = round2(subtotal - discount)
    const categoryNames = Array.from(new Set(saleLines.map((item) => item.categoryName)))

    // Snapshot the store's warranty policy and seller details onto this sale.
    // Read once here so an invoice reprinted months later shows the terms and
    // the registered details that applied on the day it was issued.
    const storeSettings = await getStoreSettings()
    const saleWarrantyDays = storeSettings.warrantyDays

    // Step 11: Generate unique receipt number for the sale document
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
        ...(item.lineKey !== item.itemId ? { lineKey: item.lineKey } : {}),
        name: item.name,
        quantity: item.quantity,
        price: item.price,
        categoryId: item.categoryId,
        categoryName: item.categoryName,
        condition: item.condition,
        ...(item.conditionNotes ? { conditionNotes: item.conditionNotes } : {}),
        ...(item.unitLines ? { unitLines: item.unitLines } : {}),
        warrantyDays: saleWarrantyDays,
        status: 'completed',
      })),
      categoryName: categoryNames.join(', '),
      category: categoryNames.join(', '),
      customer: customerDetails.fullName,
      customerName: customerDetails.fullName,
      customerEmail: customerDetails.email,
      customerContactNumber: customerDetails.contactNumber,
      // What the customer paid. subtotal is the list value of the lines.
      subtotal,
      discount,
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
      createdAt: FieldValue.serverTimestamp(),
      transactionDate: nowIso,
    }), nowIso)

    await Promise.all(
      [
        ...stockMoves.map((item) =>
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
            units: item.units.map((u) => ({ id: u.id, unitCode: u.unitCode })),
            remarks: `Sale ${numberResult.value} completed.` + describeUnits(item.units),
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
      // A unit-tracked line prints each piece's grade and notes, which is what
      // a later refund about its condition turns on.
      ...(item.unitLines
        ? { conditionNotes: item.unitLines.map((u) => `#${u.unitCode} ${u.grade}${u.conditionNotes ? ' - ' + u.conditionNotes : ''}`).join('; ') }
        : item.conditionNotes ? { conditionNotes: item.conditionNotes } : {}),
      subtotal: item.quantity * item.price,
    }))

    const receiptDocument: SaleReceiptDocument = {
      type: 'sale',
      receiptNumber: numberResult.value,
      storeName: STORE_NAME,
      storeTagline: STORE_TAGLINE,
      customer: customerDetails,
      items: receiptItems,
      ...(discount > 0 ? { subtotal, discount } : {}),
      totalAmount,
      transactionDate: nowIso,
      processedBy: processedBy.name,
      note: SALES_THANK_YOU_NOTE,
      sellerRegisteredName: storeSettings.sellerRegisteredName,
      sellerTin: storeSettings.sellerTin,
      sellerAddress: storeSettings.sellerAddress,
    }


    const receiptRecord: ReceiptRecord = {
      id: saleRef.id,
      receiptNumber: numberResult.value,
      transactionType: 'sale',
      transactionId: saleRef.id,
      customerName: customerDetails.fullName,
      contactNumber: customerDetails.contactNumber,
      items: receiptItems,
      subtotal,
      discount,
      total: totalAmount,
      cashierName: processedBy.name,
      createdAt: nowIso,
      status: 'active',
      document: receiptDocument,
    }

    await getAdminDb().collection('receipts').add(receiptRecord)

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
      if (error.message.startsWith('UNITS_UNAVAILABLE:')) {
        return NextResponse.json({ error: error.message.slice('UNITS_UNAVAILABLE:'.length) }, { status: 409 })
      }

      console.error('SALE ERROR:', error)
      return NextResponse.json({ error: error.message || 'Server error' }, { status: 500 })
    }

    console.error('SALE ERROR:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
