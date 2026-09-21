// Generates unique transaction numbers (receipt & reservation codes) using Firestore counters
import { FieldValue, type DocumentReference } from 'firebase-admin/firestore'
import { getAdminDb } from '@/lib/firebaseAdmin'

type TransactionNumberType = 'sale' | 'reservation'

interface TransactionNumberResult {
  value: string
  dateKey: string
  sequenceNumber: number
}

// Prefix for each transaction type (SALE-20250104-0001, RSV-20250104-0002)
const COUNTER_PREFIX: Record<TransactionNumberType, string> = {
  sale: 'SALE',
  reservation: 'RSV',
}

// Step 1: Convert date to YYYYMMDD format (20250104) in Manila timezone
const formatDateKey = (date: Date) => {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })

  return formatter.format(date).replace(/-/g, '')
}

// Step 2: Pad sequence number to 4 digits (1 becomes 0001)
const formatSequenceNumber = (sequenceNumber: number) => String(sequenceNumber).padStart(4, '0')

/**
 * Reserves the next number WITHOUT writing a target document.
 *
 * `createTransactionNumber` below opens its own Firestore transaction, so it
 * cannot be called from inside another one. The reservation-claim flow already
 * runs in a transaction (stock and reserved stock have to move together with
 * the sale), so it allocates its number up front with this instead.
 *
 * If the caller's own transaction then fails, the allocated number is simply
 * never used and the day's sequence has a gap. That is fine - receipt numbers
 * must be unique and ordered, not contiguous.
 */
export const allocateTransactionNumber = async (
  type: TransactionNumberType,
  createdAtIso: string
): Promise<TransactionNumberResult> => {
  const dateKey = formatDateKey(new Date(createdAtIso))
  const db = getAdminDb()
  const counterRef = db.collection('transactionCounters').doc(`${type}_${dateKey}`)

  let result: TransactionNumberResult | null = null

  await db.runTransaction(async (transaction) => {
    const counterSnapshot = await transaction.get(counterRef)
    const currentSequence =
      counterSnapshot.exists && typeof counterSnapshot.data()?.sequenceNumber === 'number'
        ? (counterSnapshot.data()!.sequenceNumber as number)
        : 0

    const nextSequence = currentSequence + 1

    transaction.set(
      counterRef,
      {
        transactionType: type,
        dateKey,
        sequenceNumber: nextSequence,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    )

    result = {
      value: `${COUNTER_PREFIX[type]}-${dateKey}-${formatSequenceNumber(nextSequence)}`,
      dateKey,
      sequenceNumber: nextSequence,
    }
  })

  if (!result) {
    throw new Error('Failed to allocate transaction number.')
  }

  return result
}

// Main function to generate unique transaction numbers atomically (prevents duplicate numbers)
export const createTransactionNumber = async (
  type: TransactionNumberType,
  targetRef: DocumentReference,
  buildPayload: (result: TransactionNumberResult) => Record<string, unknown>,
  createdAtIso: string
): Promise<TransactionNumberResult> => {
  const now = new Date(createdAtIso)
  const dateKey = formatDateKey(now)
  const counterId = `${type}_${dateKey}` // Separate counter for each transaction type per day
  const db = getAdminDb()
  const counterRef = db.collection('transactionCounters').doc(counterId)

  let result: TransactionNumberResult | null = null

  // Use transaction to ensure atomic read-modify-write (avoids duplicate sequence numbers)
  await db.runTransaction(async (transaction) => {
    // Step 1: Get current sequence number from counter
    const counterSnapshot = await transaction.get(counterRef)
    const currentSequence =
      counterSnapshot.exists && typeof counterSnapshot.data()?.sequenceNumber === 'number'
        ? (counterSnapshot.data()!.sequenceNumber as number)
        : 0

    // Step 2: Increment counter and format final transaction number
    const nextSequence = currentSequence + 1
    const value = `${COUNTER_PREFIX[type]}-${dateKey}-${formatSequenceNumber(nextSequence)}`

    // Step 3: Update counter document with new sequence
    transaction.set(
      counterRef,
      {
        transactionType: type,
        dateKey,
        sequenceNumber: nextSequence,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    )

    // Step 4: Create the transaction document with full payload
    result = {
      value,
      dateKey,
      sequenceNumber: nextSequence,
    }
    transaction.set(targetRef, buildPayload(result))
  })

  if (!result) {
    throw new Error('Failed to generate transaction number.')
  }

  return result
}
