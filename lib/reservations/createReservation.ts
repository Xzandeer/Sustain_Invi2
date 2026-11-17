// Creates a reservation through the reservations API.
//
// Used by the Sales POS (Reserve Order) and by the dashboard's Reserve Item
// quick action, so both send the same request. The API holds the stock
// (reservedStock), writes the stock log and returns the reservation ticket.
// It never records a sale: a sale is only created when the reservation is
// collected from the Reservations page.

import { apiFetch } from '@/lib/apiFetch'
import { auth } from '@/lib/firebase'
import type { CompletedTransactionDocument, ReceiptRecord } from '@/lib/transactions/transactionDocuments'

// A Philippine mobile number is 11 digits (09 followed by nine more).
// Reservations require one so the customer can be contacted when their hold is
// about to expire - a reservation nobody can be reached about just freezes stock.
/** A Philippine mobile number: 11 digits starting with 09. */
export const isValidContactNumber = (value: string) => /^09\d{9}$/.test(value.trim())

/** Why a contact number is not accepted yet, or '' when it is fine (or empty). */
export const contactNumberProblem = (value: string): string => {
  const v = value.trim()
  if (!v || isValidContactNumber(v)) return ''
  if (!v.startsWith('09')) return 'Must start with 09'
  return `Must be 11 digits (${v.length}/11)`
}

/** Email is optional; when given it must look like an address. */
export const isValidOptionalEmail = (value: string) => !value.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())

export interface ReservationLine {
  id: string
  /** The inventory item, when id is a cart line key rather than the item id. */
  itemId?: string
  name: string
  price: number
  quantity: number
  /** Scanned pieces to hold. */
  units?: Array<{ id: string }>
  /** Unit-tracked items: the condition to hold. */
  grade?: string
}

export interface ReservationCustomer {
  fullName: string
  contactNumber: string
  email?: string
}

export interface CreatedReservation {
  document: CompletedTransactionDocument | null
  receipt: ReceiptRecord | null
}

/** Throws an Error with a readable message when the reservation is refused. */
export async function createReservation(
  lines: ReservationLine[],
  customer: ReservationCustomer
): Promise<CreatedReservation> {
  if (lines.length === 0) throw new Error('Cart is empty.')
  if (!customer.fullName.trim()) throw new Error('Customer name is required for reservations.')
  if (!isValidContactNumber(customer.contactNumber)) {
    throw new Error('Enter an 11-digit contact number starting with 09.')
  }
  if (!isValidOptionalEmail(customer.email ?? '')) throw new Error('Enter a valid email address, or leave it empty.')

  const invalid = lines.find(
    (item) =>
      !item.id ||
      !item.name ||
      !Number.isFinite(item.price) ||
      item.price < 0 ||
      !Number.isFinite(item.quantity) ||
      item.quantity <= 0
  )
  if (invalid) {
    throw new Error(`Invalid cart item: ${invalid.name || invalid.id || 'Unknown item'}`)
  }

  const response = await apiFetch('/api/reservations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: lines.map((item) => ({
        itemId: item.itemId ?? item.id,
        quantity: item.quantity,
        ...(item.grade ? { grade: item.grade } : {}),
        // Scanned pieces (lib/inventory/units.ts); the rest are the oldest.
        ...(item.units?.length ? { unitIds: item.units.map((u) => u.id) } : {}),
      })),
      customerDetails: {
        fullName: customer.fullName.trim(),
        email: (customer.email ?? '').trim(),
        contactNumber: customer.contactNumber.trim(),
      },
      processedBy: {
        uid: auth.currentUser?.uid ?? '',
        email: auth.currentUser?.email ?? '',
        name: auth.currentUser?.displayName ?? auth.currentUser?.email ?? '',
      },
    }),
  })

  const result = (await response.json().catch(() => ({}))) as {
    error?: string
    document?: CompletedTransactionDocument
    receipt?: ReceiptRecord
  }
  if (!response.ok) {
    throw new Error(result.error || 'Failed to create reservation.')
  }
  return { document: result.document ?? null, receipt: result.receipt ?? null }
}
