import { collection, doc, runTransaction, serverTimestamp } from 'firebase/firestore'
import { db } from '@/lib/firebase'

type TransactionNumberType = 'sale' | 'reservation'

interface TransactionNumberResult {
  value: string
  dateKey: string
  sequenceNumber: number
}

const COUNTER_PREFIX: Record<TransactionNumberType, string> = {
  sale: 'SALE',
  reservation: 'RSV',
}

const formatDateKey = (date: Date) => {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })

  return formatter.format(date).replace(/-/g, '')
}

const formatSequenceNumber = (sequenceNumber: number) => String(sequenceNumber).padStart(4, '0')

export const createTransactionNumber = async (
  type: TransactionNumberType,
  targetRef: ReturnType<typeof doc>,
  buildPayload: (result: TransactionNumberResult) => Record<string, unknown>,
  createdAtIso: string
): Promise<TransactionNumberResult> => {
  const now = new Date(createdAtIso)
  const dateKey = formatDateKey(now)
  const counterId = `${type}_${dateKey}`
  const counterRef = doc(db, 'transactionCounters', counterId)

  let result: TransactionNumberResult | null = null

  await runTransaction(db, async (transaction) => {
    const counterSnapshot = await transaction.get(counterRef)
    const currentSequence =
      counterSnapshot.exists() && typeof counterSnapshot.data().sequenceNumber === 'number'
        ? counterSnapshot.data().sequenceNumber
        : 0

    const nextSequence = currentSequence + 1
    const value = `${COUNTER_PREFIX[type]}-${dateKey}-${formatSequenceNumber(nextSequence)}`

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
