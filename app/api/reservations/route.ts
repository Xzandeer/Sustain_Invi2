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
  DEFAULT_CLAIM_INSTRUCTIONS,
  RESERVATION_NOTICE,
  STORE_NAME,
  STORE_TAGLINE,
  TransactionLineItem,
  ReservationTicketDocument,
  ReceiptRecord,
} from '@/lib/transactionDocuments'

interface ReservationPayload {
  items?: unknown
  customerDetails?: unknown
  processedBy?: unknown
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

    const range = parseDateRange(startDate, endDate)
    if ('error' in range) {
      return NextResponse.json({ error: range.error }, { status: 400 })
    }

    const reservationsQuery = query(collection(db, 'reservations'))
    const snapshot = await getDocs(reservationsQuery)

    let records: Array<Record<string, unknown> & { id: string }> = snapshot.docs.map((reservationDoc) => ({
      ...(reservationDoc.data() as Record<string, unknown>),
      id: reservationDoc.id,
    }))

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
    console.error('GET /api/reservations error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as ReservationPayload
    const customerDetails = parseCustomerDetails(body.customerDetails)
    const processedBy = await getProcessedByInfo(body.processedBy)
    const items = Array.isArray(body.items) ? body.items : []

    if (!customerDetails) {
      return NextResponse.json(
        { error: 'Customer full name and contact number are required.' },
        { status: 400 }
      )
    }

    const normalizedItems = items
      .map((item) => {
        const record = item as Record<string, unknown>
        const itemId = typeof record.itemId === 'string' ? record.itemId.trim() : ''
        const quantity = Math.floor(toNumber(record.quantity, Number.NaN))
        return { itemId, quantity }
      })
      .filter((item) => item.itemId && Number.isFinite(item.quantity) && item.quantity > 0)

    if (normalizedItems.length === 0) {
      return NextResponse.json({ error: 'Add at least one valid item to continue.' }, { status: 400 })
    }

    const now = new Date()
    const nowIso = now.toISOString()
    const expiresAt = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000)
    const preparedItems = await Promise.all(
      normalizedItems.map(async (requestedItem) => {
        const inventoryItem = await findInventoryVariantById(requestedItem.itemId)
        if (!inventoryItem || inventoryItem.isDeleted) {
          throw new Error('ITEM_NOT_FOUND')
        }
        return { requestedItem, inventoryItem }
      })
    )

    const reservationItems: Array<{
      id: string
      name: string
      quantity: number
      price: number
      condition: string
      availableBefore: number
      availableAfter: number
      stockBefore: number
      stockAfter: number
      reservedBefore: number
      reservedAfter: number
    }> = []

    await runTransaction(db, async (transaction) => {
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

        const nextReservedStock = currentReservedStock + requestedItem.quantity
        transaction.update(inventoryItem.ref, {
          reservedStock: nextReservedStock,
          updatedAt: nowIso,
        })

        reservationItems.push({
          id: inventoryItem.id,
          name: inventoryItem.name,
          quantity: requestedItem.quantity,
          price: inventoryItem.price,
          condition: inventoryItem.condition,
          availableBefore: availableStock,
          availableAfter: availableStock - requestedItem.quantity,
          stockBefore: currentStock,
          stockAfter: currentStock,
          reservedBefore: currentReservedStock,
          reservedAfter: nextReservedStock,
        })
      }
    })

    const reservationRef = doc(collection(db, 'reservations'))
    const numberResult = await createTransactionNumber('reservation', reservationRef, (numberInfo) => ({
      id: reservationRef.id,
      reservationNumber: numberInfo.value,
      transactionType: 'reservation',
      dateKey: numberInfo.dateKey,
      sequenceNumber: numberInfo.sequenceNumber,
      searchableNumber: numberInfo.value,
      customerSearchEmail: customerDetails.email.toLowerCase(),
      items: reservationItems.map((item) => ({
        id: item.id,
        name: item.name,
        quantity: item.quantity,
        price: item.price,
        condition: item.condition,
      })),
      customer: customerDetails.fullName,
      customerName: customerDetails.fullName,
      customerEmail: customerDetails.email,
      customerContactNumber: customerDetails.contactNumber,
      processedByName: processedBy.name,
      processedByEmail: processedBy.email ?? '',
      status: 'Active',
      claimInstructions: DEFAULT_CLAIM_INSTRUCTIONS,
      createdAt: serverTimestamp(),
      expiresAt: expiresAt.toISOString(),
      reservationDate: nowIso,
    }), nowIso)

    await Promise.all(
      [
        ...reservationItems.map((item) =>
          createStockLog({
            actionType: 'reservation_deduction',
            itemId: item.id,
            itemName: item.name,
            condition: item.condition === 'Refurbished' ? 'Refurbished' : 'New',
            quantityBefore: item.availableBefore,
            quantityChanged: item.quantity * -1,
            quantityAfter: item.availableAfter,
            stockBefore: item.stockBefore,
            stockAfter: item.stockAfter,
            reservedBefore: item.reservedBefore,
            reservedAfter: item.reservedAfter,
            user: processedBy,
            relatedId: reservationRef.id,
            remarks: `Reservation ${numberResult.value} created.`,
          })
        ),
      ]
    )

    const ticketItems: TransactionLineItem[] = reservationItems.map((item) => ({
      itemId: item.id,
      name: item.name,
      quantity: item.quantity,
      price: item.price,
      condition: item.condition,
      subtotal: item.quantity * item.price,
    }))

    const ticketDocument: ReservationTicketDocument = {
      type: 'reservation',
      reservationCode: numberResult.value,
      storeName: STORE_NAME,
      storeTagline: STORE_TAGLINE,
      customer: customerDetails,
      items: ticketItems,
      reservationDate: nowIso,
      processedBy: processedBy.name,
      claimInstructions: DEFAULT_CLAIM_INSTRUCTIONS,
      notice: RESERVATION_NOTICE,
    }

    const receiptRecord: ReceiptRecord = {
      id: reservationRef.id,
      receiptNumber: numberResult.value,
      transactionType: 'reservation',
      transactionId: reservationRef.id,
      customerName: customerDetails.fullName,
      contactNumber: customerDetails.contactNumber,
      items: ticketItems,
      subtotal: reservationItems.reduce((sum, item) => sum + item.quantity * item.price, 0),
      discount: 0,
      total: reservationItems.reduce((sum, item) => sum + item.quantity * item.price, 0),
      cashierName: processedBy.name,
      createdAt: nowIso,
      status: 'active',
      document: ticketDocument,
    }

    await addDoc(collection(db, 'receipts'), receiptRecord)

    return NextResponse.json(
      {
        data: {
          id: reservationRef.id,
          reservationNumber: numberResult.value,
          items: ticketItems,
          customer: customerDetails.fullName,
          createdAt: nowIso,
          expiresAt: expiresAt.toISOString(),
        },
        document: ticketDocument,
        receipt: receiptRecord,
      },
      { status: 201 }
    )
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === 'INSUFFICIENT_STOCK') {
        return NextResponse.json({ error: 'Cannot reserve more than available stock.' }, { status: 400 })
      }

      if (error.message === 'ITEM_NOT_FOUND') {
        return NextResponse.json({ error: 'One or more selected items were not found.' }, { status: 404 })
      }
    }

    console.error('POST /api/reservations error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
