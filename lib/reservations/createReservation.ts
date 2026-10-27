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
export const isValidContactNumber = (value: string) => /^\d{11}$/.test(value.trim())

export interface ReservationLine {
  id: string
  name: string
  price: number
  quantity: number
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
    throw new Error('Enter an 11-digit contact number for reservations.')
  }

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
      items: lines.map((item) => ({ itemId: item.id, quantity: item.quantity })),
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
