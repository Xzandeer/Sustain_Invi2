import { NextRequest, NextResponse } from 'next/server'
import { collection, doc, getDocs, query, runTransaction, serverTimestamp, addDoc } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import {
  createStockLog,
  findInventoryVariantById,
  getProcessedByInfo,
} from '@/lib/server/inventory'
import { createTransactionNumber } from '@/lib/server/transactionNumbers'
import { parseDateRange, toDate, toNumber } from '@/lib/server/salesInventoryMetrics'
import {
  SALES_THANK_YOU_NOTE,
  STORE_NAME,
  STORE_TAGLINE,
  TransactionLineItem,
  SaleReceiptDocument,
  ReceiptRecord,
} from '@/lib/transactionDocuments'

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

const parseCustomerDetails = (input: unknown): CustomerDetails | null => {
  if (!input || typeof input !== 'object') return null

  const data = input as Record<string, unknown>
  const fullName = typeof data.fullName === 'string' ? data.fullName.trim() : ''
  const email = typeof data.email === 'string' ? data.email.trim() : ''
  const contactNumber = typeof data.contactNumber === 'string' ? data.contactNumber.trim() : ''

  if (!fullName || !contactNumber) {
    return null
  }

  return { fullName, email, contactNumber }
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const startDate = searchParams.get('startDate')
    const endDate = searchParams.get('endDate')
    const categoryName = searchParams.get('category')

    const range = parseDateRange(startDate, endDate)
    if ('error' in range) {
      return NextResponse.json({ error: range.error }, { status: 400 })
    }

    const snapshot = await getDocs(collection(db, 'sales'))

    let records: Array<Record<string, unknown> & { id: string }> = snapshot.docs.map((saleDoc) => ({
      ...(saleDoc.data() as Record<string, unknown>),
      id: saleDoc.id,
    }))

    if (categoryName && categoryName !== 'all') {
      records = records.filter((record) => record.categoryName === categoryName || record.category === categoryName)
    }

    if (range.start || range.end) {
      records = records.filter((record) => {
        const recordDate = toDate(record.createdAt)
        if (!recordDate) return false
        if (range.start && recordDate < range.start) return false
        if (range.end && recordDate > range.end) return false
        return true
      })
    }

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

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as SalesPayload
    const customerDetails = parseCustomerDetails(body.customerDetails)
    const processedBy = await getProcessedByInfo(body.processedBy)
    const reduceQuantity = body.reduceQuantity !== false
    const payloadItems = Array.isArray(body.items)
      ? body.items
      : typeof body.itemId === 'string'
        ? [{ itemId: body.itemId, quantity: body.quantity }]
        : []

    if (!customerDetails) {
      return NextResponse.json(
        { error: 'Customer full name and contact number are required.' },
        { status: 400 }
      )
    }

    const normalizedItems = payloadItems
      .map((item) => {
        const record = item as Record<string, unknown>
        const itemId = typeof record.itemId === 'string' ? record.itemId.trim() : ''
        const quantity = Math.floor(toNumber(record.quantity, Number.NaN))
        return { itemId, quantity }
      })
      .filter((item) => item.itemId && Number.isFinite(item.quantity) && item.quantity > 0)

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

    if (mergedItems.length === 0) {
      return NextResponse.json({ error: 'Add at least one valid item to continue.' }, { status: 400 })
    }

    const now = new Date()
    const nowIso = now.toISOString()
    const preparedItems = await Promise.all(
      mergedItems.map(async (requestedItem) => {
        const inventoryItem = await findInventoryVariantById(requestedItem.itemId)
        if (!inventoryItem || inventoryItem.isDeleted) {
          throw new Error('ITEM_NOT_FOUND')
        }
        return {
          requestedItem,
          inventoryItem,
        }
      })
    )

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

    await runTransaction(db, async (transaction) => {
      const pendingUpdates: Array<{
        ref: typeof preparedItems[number]['inventoryItem']['ref']
        nextStock: number
      }> = []

      for (const { requestedItem, inventoryItem } of preparedItems) {
        const inventorySnapshot = await transaction.get(inventoryItem.ref)
        if (!inventorySnapshot.exists()) {
          throw new Error('ITEM_NOT_FOUND')
        }

        const latestData = inventorySnapshot.data() as Record<string, unknown>
        const currentStock = Math.max(0, toNumber(latestData.stock ?? latestData.quantity, 0))
        const currentReservedStock = Math.max(0, toNumber(latestData.reservedStock, 0))
        const availableStock = Math.max(0, currentStock - currentReservedStock)

        if (requestedItem.quantity > availableStock) {
          throw new Error('INSUFFICIENT_STOCK')
        }

        const nextStock = currentStock - requestedItem.quantity
        pendingUpdates.push({
          ref: inventoryItem.ref,
          nextStock,
        })

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

      if (!reduceQuantity) {
        return
      }

      for (const update of pendingUpdates) {
        transaction.update(update.ref, {
          quantity: update.nextStock,
          stock: update.nextStock,
          updatedAt: nowIso,
        })
      }
    })

    const totalAmount = saleLines.reduce((sum, item) => sum + item.quantity * item.price, 0)
    const categoryNames = Array.from(new Set(saleLines.map((item) => item.categoryName)))
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
