// Item barcodes.
//
// Every inventory variant gets a short numeric code, stored on the item as
// `barcode`. New and Refurbished are separate documents and therefore separate
// codes, which is correct - they carry different prices.
//
// WHY SIX DIGITS
// Thermal printers are 203 dpi. A long code forces the bars narrower than the
// scanner can resolve, and it silently fails to read. Six digits prints legibly
// at 58mm and allows a million items, which no surplus shop will exhaust.
//
// The code identifies the ITEM, not the individual unit. Twelve units in stock
// means twelve identical labels. Scanning three of them adds a quantity of
// three, exactly as a supermarket handles identical goods.
//
// Per-unit serialisation - where each physical item carries its own code,
// condition and history - would suit second-hand goods better, but it is a
// change to the data model rather than a feature. Recorded as future work.

import { doc, runTransaction } from 'firebase/firestore'
import { db } from '@/lib/firebase'

const COUNTER_COLLECTION = 'transactionCounters'
const COUNTER_ID = 'itemBarcode'

/** Code 128 encodes digits efficiently, so a numeric code keeps the bars wide. */
const formatBarcode = (sequence: number) => String(sequence).padStart(6, '0')

/**
 * Reserves the next barcode atomically.
 *
 * Uses the same counter collection as invoice numbers so all sequence state
 * lives in one place. The transaction prevents two items created at the same
 * moment from receiving the same code.
 */
export async function createItemBarcode(): Promise<string> {
  const counterRef = doc(db, COUNTER_COLLECTION, COUNTER_ID)

  let next = 1
  await runTransaction(db, async (txn) => {
    const snap = await txn.get(counterRef)
    const current = snap.exists() ? Number((snap.data() as Record<string, unknown>).sequence) : 0
    next = Number.isFinite(current) && current > 0 ? current + 1 : 1
    txn.set(counterRef, { sequence: next, updatedAt: new Date().toISOString() }, { merge: true })
  })

  return formatBarcode(next)
}

/**
 * Normalises whatever a scanner typed into a comparable code.
 *
 * Hardware scanners often append a carriage return, and some prefix a symbology
 * character. Stripping to digits and re-padding means a scan, a manual typo with
 * a space, and a stored code all compare equal.
 */
export function normalizeBarcode(input: unknown): string {
  if (typeof input !== 'string') return ''
  const digits = input.replace(/\D/g, '')
  if (!digits) return ''
  return digits.length >= 6 ? digits : digits.padStart(6, '0')
}
