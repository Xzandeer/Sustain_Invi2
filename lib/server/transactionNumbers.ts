// Generates unique transaction numbers (receipt & reservation codes) using Firestore counters
import { collection, doc, runTransaction, serverTimestamp } from 'firebase/firestore'
import { db } from '@/lib/firebase'

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

// Main function to generate unique transaction numbers atomically (prevents duplicate numbers)
export const createTransactionNumber = async (
  type: TransactionNumberType,
  targetRef: ReturnType<typeof doc>,
  buildPayload: (result: TransactionNumberResult) => Record<string, unknown>,
  createdAtIso: string
): Promise<TransactionNumberResult> => {
  const now = new Date(createdAtIso)
  const dateKey = formatDateKey(now)
  const counterId = `${type}_${dateKey}` // Separate counter for each transaction type per day
  const counterRef = doc(db, 'transactionCounters', counterId)

  let result: TransactionNumberResult | null = null

  // Use transaction to ensure atomic read-modify-write (avoids duplicate sequence numbers)
  await runTransaction(db, async (transaction) => {
    // Step 1: Get current sequence number from counter
    const counterSnapshot = await transaction.get(counterRef)
    const currentSequence =
      counterSnapshot.exists() && typeof counterSnapshot.data().sequenceNumber === 'number'
        ? counterSnapshot.data().sequenceNumber
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
        updatedAt: serverTimestamp(),
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
