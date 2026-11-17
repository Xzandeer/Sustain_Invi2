// Reservations API endpoint - POST to create reservations, GET to list reservations
import { INPUT_LIMITS } from '@/lib/constants/limits'
import { NextRequest, NextResponse } from 'next/server'
import { getReservationDays } from '@/lib/server/storeSettings'
import { FieldValue } from 'firebase-admin/firestore'
import { getAdminDb } from '@/lib/firebaseAdmin'
import {
  createStockLog,
  findInventoryVariantById,
  getProcessedByInfo,
} from '@/lib/server/inventory'
import {
  describeUnits, isUnitTracked, parseItemRequests, pickUnitsForParts, readItemUnits, setUnitsStatus, toLineRef,
  unitPrice, type StoredUnit,
} from '@/lib/server/units'
import { getStoreSettings } from '@/lib/server/storeSettings'
import type { UnitLineRef } from '@/lib/inventory/units'
import { heldLines } from '@/lib/reservations/heldLines'
import { createTransactionNumber } from '@/lib/server/transactionNumbers'
import { parseDateRange, toDate, toNumber } from '@/lib/server/salesInventoryMetrics'
import {
  claimInstructionsFor,
  RESERVATION_NOTICE,
  STORE_NAME,
  STORE_TAGLINE,
  TransactionLineItem,
  ReservationTicketDocument,
  ReceiptRecord,
} from '@/lib/transactions/transactionDocuments'
import { guardRequest } from '@/lib/server/authorize'

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

// Helper: Validate and parse customer information
const parseCustomerDetails = (input: unknown): CustomerDetails | null => {
  if (!input || typeof input !== 'object') return null
  const data = input as Record<string, unknown>
  const fullName = typeof data.fullName === 'string' ? data.fullName.trim().slice(0, INPUT_LIMITS.name) : ''
  const email = typeof data.email === 'string' ? data.email.trim().slice(0, INPUT_LIMITS.email) : ''
  const contactNumber = typeof data.contactNumber === 'string' ? data.contactNumber.trim().slice(0, 15) : ''

  return { fullName, email, contactNumber }
}

// GET /api/reservations - List reservations with optional date filtering
export async function GET(req: NextRequest) {
  // Read access is checked here, not left to the database rules: this route
  // uses the Admin SDK, which bypasses the rules entirely. Without this line
  // the data below is returned to anyone on the internet who calls the URL.
  // Customer names and contact numbers - same permission as the Reservations
  // page and the reservations rule in firestore.rules.
  const denied = await guardRequest(req, 'canManageReservations')
  if (denied) return denied

  try {
    // Step 1: Parse query parameters
    const { searchParams } = new URL(req.url)
    const startDate = searchParams.get('startDate')
    const endDate = searchParams.get('endDate')

    // Step 2: Validate date range
    const range = parseDateRange(startDate, endDate)
    if ('error' in range) {
      return NextResponse.json({ error: range.error }, { status: 400 })
    }

    // Step 3: Fetch all reservations
    const snapshot = await getAdminDb().collection('reservations').get()

    let records: Array<Record<string, unknown> & { id: string }> = snapshot.docs.map((reservationDoc) => ({
      ...(reservationDoc.data() as Record<string, unknown>),
      id: reservationDoc.id,
    }))

    // Step 4: Filter by date range if specified
    if (range.start || range.end) {
      records = records.filter((record) => {
        const recordDate = toDate(record.createdAt)
        if (!recordDate) return false
        if (range.start && recordDate < range.start) return false
        if (range.end && recordDate > range.end) return false
        return true
      })
    }

    // Step 5: Sort by most recent first
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
    // STEP 1: Parse request body
    console.log('[reservations POST] step 1: parsing body')
    const body = (await req.json()) as ReservationPayload
    const customerDetails = parseCustomerDetails(body.customerDetails)

    // Creating a reservation moves stock into reserved, so it is gated.
  const denied = await guardRequest(req, 'canManageReservations')
  if (denied) return denied

    const processedBy = await getProcessedByInfo(req)
    const items = Array.isArray(body.items) ? body.items : []

    if (!customerDetails) {
      return NextResponse.json(
        { error: 'Invalid customer details.' },
        { status: 400 }
      )
    }

    // A reservation holds stock for a named person. Without a name it cannot be
    // matched to anyone at collection, and without a contact number nobody can
    // be told the hold is about to expire - the stock would just sit frozen.
    // The form enforces this too; this is the check that cannot be bypassed.
    if (!customerDetails.fullName) {
      return NextResponse.json(
        { error: 'A customer name is required for reservations.' },
        { status: 400 }
      )
    }
    if (!/^09\d{9}$/.test(customerDetails.contactNumber)) {
      return NextResponse.json(
        { error: 'An 11-digit contact number starting with 09 is required for reservations.' },
        { status: 400 }
      )
    }
    if (customerDetails.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerDetails.email)) {
      return NextResponse.json({ error: 'Enter a valid email address, or leave it empty.' }, { status: 400 })
    }

    // One line per item - the hold, claim and release code updates each item
    // once - with a part per condition asked for and any scanned pieces.
    const normalizedItems = parseItemRequests(items)

    if (normalizedItems.length === 0) {
      return NextResponse.json({ error: 'Add at least one valid item to continue.' }, { status: 400 })
    }

    const now = new Date()
    const nowIso = now.toISOString()
    // Hold period comes from Settings so the shop can match whatever it tells
    // customers, rather than a number buried in this file.
    const holdDays = await getReservationDays()
    const expiresAt = new Date(now.getTime() + holdDays * 24 * 60 * 60 * 1000)

    // STEP 2: Fetch inventory items
    console.log('[reservations POST] step 2: fetching inventory items', normalizedItems)
    const preparedItems = await Promise.all(
      normalizedItems.map(async (requestedItem) => {
        const inventoryItem = await findInventoryVariantById(requestedItem.itemId)
        if (!inventoryItem || inventoryItem.isDeleted) {
          throw new Error('ITEM_NOT_FOUND')
        }
        if (inventoryItem.isVoided) {
          throw new Error('ITEM_VOIDED')
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
      units: StoredUnit[]
      unitLines: UnitLineRef[]
    }> = []

    // Known before the transaction, so held units can point at it.
    const reservationRef = getAdminDb().collection('reservations').doc()

    // Price by condition - the hold records what each piece will sell for.
    const { gradePricing } = await getStoreSettings()

    // STEP 3: Firestore transaction - update reservedStock
    console.log('[reservations POST] step 3: running inventory transaction')
    await getAdminDb().runTransaction(async (transaction) => {
      // Firestore requires EVERY read in a transaction to precede ANY write, so
      // reading and updating inside one loop fails as soon as there is a second
      // item: its read lands after the first item's write. Two phases instead.
      const holdWrites: Array<{
        ref: (typeof preparedItems)[number]['inventoryItem']['ref']
        inventoryItem: (typeof preparedItems)[number]['inventoryItem']
        quantity: number
        currentStock: number
        currentReservedStock: number
        availableStock: number
        nextReservedStock: number
        units: StoredUnit[]
      }> = []
      reservationItems.length = 0 // a retried transaction must not repeat lines

      // ── Phase 1: read and validate every line ──
      for (const { requestedItem, inventoryItem } of preparedItems) {
        const inventorySnapshot = await transaction.get(inventoryItem.ref)
        if (!inventorySnapshot.exists) {
          throw new Error('ITEM_NOT_FOUND')
        }

        const latestData = inventorySnapshot.data() as Record<string, unknown>
        const currentStock = Math.max(0, toNumber(latestData.stock ?? latestData.quantity, 0))
        const currentReservedStock = Math.max(0, toNumber(latestData.reservedStock, 0))
        const availableStock = Math.max(0, currentStock - currentReservedStock)

        if (requestedItem.quantity > availableStock) {
          throw new Error('INSUFFICIENT_STOCK')
        }

        // Unit-tracked: hold the scanned pieces, then the oldest on the shelf.
        const units = isUnitTracked(latestData)
          ? pickUnitsForParts(
              await readItemUnits(transaction, inventoryItem.id, 'in_stock'),
              requestedItem.parts,
              inventoryItem.name
            )
          : []

        holdWrites.push({
          ref: inventoryItem.ref,
          inventoryItem,
          quantity: requestedItem.quantity,
          currentStock,
          currentReservedStock,
          availableStock,
          nextReservedStock: currentReservedStock + requestedItem.quantity,
          units,
        })
      }

      // ── Phase 2: write ──
      for (const entry of holdWrites) {
        const { ref, inventoryItem, quantity, currentStock, currentReservedStock, availableStock, nextReservedStock, units } = entry

        transaction.update(ref, {
          reservedStock: nextReservedStock,
          updatedAt: nowIso,
        })
        setUnitsStatus(transaction, units, 'reserved', nowIso, { reservationId: reservationRef.id })

        reservationItems.push({
          id: inventoryItem.id,
          name: inventoryItem.name,
          quantity,
          price: inventoryItem.price,
          condition: inventoryItem.condition,
          availableBefore: availableStock,
          availableAfter: availableStock - quantity,
          stockBefore: currentStock,
          stockAfter: currentStock,
          reservedBefore: currentReservedStock,
          reservedAfter: nextReservedStock,
          units,
          unitLines: units.map((u) => toLineRef(u, unitPrice(u, inventoryItem.price, gradePricing))),
        })
      }
    })

    // STEP 4: Generate reservation number + create Firestore doc
    console.log('[reservations POST] step 4: creating transaction number')
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
        // The exact pieces held - claimed or released by the same ids.
        ...(item.units.length > 0 ? { unitIds: item.units.map((u) => u.id), unitLines: item.unitLines } : {}),
      })),
      customer: customerDetails.fullName,
      customerName: customerDetails.fullName,
      customerEmail: customerDetails.email,
      customerContactNumber: customerDetails.contactNumber,
      processedByName: processedBy.name,
      processedByEmail: processedBy.email ?? '',
      status: 'Active',
      claimInstructions: claimInstructionsFor(holdDays),
      createdAt: FieldValue.serverTimestamp(),
      expiresAt: expiresAt.toISOString(),
      reservationDate: nowIso,
    }), nowIso)
    console.log('[reservations POST] step 4 done, number:', numberResult.value)

    // STEP 5: Create stock logs
    console.log('[reservations POST] step 5: writing stock logs')
    await Promise.all(
      reservationItems.map((item) =>
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
          units: item.units.map((u) => ({ id: u.id, unitCode: u.unitCode, grade: u.grade })),
          remarks: `Reservation ${numberResult.value} created.` + describeUnits(item.units),
        })
      )
    )

    // STEP 6: Build ticket document + receipt record
    console.log('[reservations POST] step 6: building documents')
    // One line per condition and price of the pieces held, named by that
    // condition (Good, Fair...) - not the item's New/Refurbished.
    const ticketItems: TransactionLineItem[] = reservationItems.flatMap((item) =>
      item.units.length > 0
        ? heldLines({ id: item.id, name: item.name, quantity: item.quantity, price: item.price, condition: item.condition, unitLines: item.unitLines }).map((line) => ({
            itemId: item.id,
            name: item.name,
            quantity: line.quantity,
            price: line.price,
            condition: line.condition,
            ...(line.unitCodes.length > 0 ? { conditionNotes: line.unitCodes.map((c) => `#${c}`).join(', ') } : {}),
            subtotal: line.quantity * line.price,
          }))
        : [{
            itemId: item.id,
            name: item.name,
            quantity: item.quantity,
            price: item.price,
            condition: item.condition,
            subtotal: item.quantity * item.price,
          }]
    )
    const ticketTotal = ticketItems.reduce((sum, item) => sum + item.subtotal, 0)

    const ticketDocument: ReservationTicketDocument = {
      type: 'reservation',
      reservationCode: numberResult.value,
      storeName: STORE_NAME,
      storeTagline: STORE_TAGLINE,
      customer: customerDetails,
      items: ticketItems,
      reservationDate: nowIso,
      processedBy: processedBy.name,
      claimInstructions: claimInstructionsFor(holdDays),
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
      subtotal: ticketTotal,
      discount: 0,
      total: ticketTotal,
      cashierName: processedBy.name,
      createdAt: nowIso,
      status: 'active',
      document: ticketDocument,
    }

    // STEP 7: Save receipt to Firestore
    console.log('[reservations POST] step 7: saving receipt')
    await getAdminDb().collection('receipts').add(receiptRecord)
    console.log('[reservations POST] done!')

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
      if (error.message.startsWith('UNITS_UNAVAILABLE:')) {
        return NextResponse.json({ error: error.message.slice('UNITS_UNAVAILABLE:'.length) }, { status: 409 })
      }
    }

    const errorMessage = error instanceof Error ? error.message : String(error)
    const errorCode = (error as Record<string, unknown>)?.code
    console.error('[reservations POST] FAILED:', { step: 'unknown', message: errorMessage, code: errorCode, error })
    return NextResponse.json({ error: errorMessage || 'Server error', code: errorCode }, { status: 500 })
  }
}
