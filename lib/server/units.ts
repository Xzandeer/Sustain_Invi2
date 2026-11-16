// Server-side unit operations, used inside the same Firestore transactions that
// move an item's counts. See lib/inventory/units.ts for the model.
//
// Every route that moves stock follows one pattern for a unit-tracked item:
//   1. read phase   - readItemUnits() for the status it needs (in_stock to sell
//                     or reserve, reserved to claim or release), alongside the
//                     item read it already does
//   2. pick         - pickUnits(): the units the caller named (a scanned label)
//                     first, then the oldest of the rest (first in, first out)
//   3. write phase  - setUnitsStatus() next to the item's count update
// so a unit and its item's count can never disagree.

import { FieldValue, type DocumentReference, type Transaction } from 'firebase-admin/firestore'
import { getAdminDb } from '@/lib/firebaseAdmin'
import {
  DEFAULT_GRADE_PRICING,
  DEFAULT_UNIT_GRADE,
  UNITS_COLLECTION,
  UNIT_CODE_LENGTH,
  gradePrice,
  legacyConditionOf,
  normalizeTrackingMode,
  normalizeUnitGrade,
  type GradePricing,
  type UnitDetails,
  type UnitGrade,
  type UnitLineRef,
  type UnitStatus,
} from '@/lib/inventory/units'

export interface StoredUnit {
  id: string
  ref: DocumentReference
  itemId: string
  unitCode: string
  grade: UnitGrade
  conditionNotes: string
  priceOverride: number | null
  status: UnitStatus
  receivedAt: string
}

export const isUnitTracked = (itemData: Record<string, unknown> | undefined) =>
  normalizeTrackingMode(itemData?.trackingMode) === 'unit'

export const unitsCollection = () => getAdminDb().collection(UNITS_COLLECTION)

export const parseUnit = (id: string, data: Record<string, unknown>): StoredUnit => ({
  id,
  ref: unitsCollection().doc(id),
  itemId: typeof data.itemId === 'string' ? data.itemId : '',
  unitCode: typeof data.unitCode === 'string' ? data.unitCode : '',
  grade: normalizeUnitGrade(data.grade),
  conditionNotes: typeof data.conditionNotes === 'string' ? data.conditionNotes : '',
  priceOverride: typeof data.priceOverride === 'number' && data.priceOverride > 0 ? data.priceOverride : null,
  status: (['in_stock', 'reserved', 'sold', 'written_off'] as const).includes(data.status as UnitStatus)
    ? (data.status as UnitStatus)
    : 'in_stock',
  receivedAt: typeof data.receivedAt === 'string' ? data.receivedAt : '',
})

// ── Codes ────────────────────────────────────────────────────────────────────

/**
 * Reserves `count` consecutive unit codes in one counter transaction.
 * Must run BEFORE the caller's own transaction: Firestore transactions cannot
 * nest. A code reserved for a transaction that then fails is simply skipped.
 */
export async function allocateUnitCodes(count: number): Promise<string[]> {
  if (count <= 0) return []
  const db = getAdminDb()
  const counterRef = db.collection('transactionCounters').doc('unitCode')
  let first = 1
  await db.runTransaction(async (txn) => {
    const snap = await txn.get(counterRef)
    const current = snap.exists ? Number((snap.data() as Record<string, unknown>).sequence) : 0
    first = Number.isFinite(current) && current > 0 ? current + 1 : 1
    txn.set(counterRef, { sequence: first + count - 1, updatedAt: new Date().toISOString() }, { merge: true })
  })
  return Array.from({ length: count }, (_, i) => String(first + i).padStart(UNIT_CODE_LENGTH, '0'))
}

// ── Creating units ───────────────────────────────────────────────────────────

/**
 * Writes new in-stock units through the transaction. `details` applies to all
 * of them (one grade and note for a delivery of identical pieces); each piece
 * can be re-graded on its own afterwards from Inventory.
 */
export function writeNewUnits(
  txn: Transaction,
  params: {
    itemId: string
    itemName: string
    codes: string[]
    /** One set of details for every piece... */
    details?: UnitDetails
    /** ...or one per piece, in the same order as codes (Receive stock). */
    detailsList?: UnitDetails[]
    nowIso: string
    source: string
  }
): StoredUnit[] {
  return params.codes.map((unitCode, i) => {
    const details = params.detailsList?.[i] ?? params.details
    const grade = normalizeUnitGrade(details?.grade ?? DEFAULT_UNIT_GRADE)
    const conditionNotes = (details?.conditionNotes ?? '').trim()
    const priceOverride =
      typeof details?.priceOverride === 'number' && details.priceOverride > 0 ? details.priceOverride : null
    const ref = unitsCollection().doc()
    txn.set(ref, {
      id: ref.id,
      itemId: params.itemId,
      itemName: params.itemName,
      unitCode,
      grade,
      conditionNotes,
      priceOverride,
      status: 'in_stock',
      receivedAt: params.nowIso,
      source: params.source,
      reservationId: null,
      saleId: null,
      soldAt: null,
      writtenOffAt: null,
      createdAt: params.nowIso,
      updatedAt: params.nowIso,
    })
    return { id: ref.id, ref, itemId: params.itemId, unitCode, grade, conditionNotes, priceOverride, status: 'in_stock', receivedAt: params.nowIso }
  })
}

// ── Reading and picking ──────────────────────────────────────────────────────

/** Every unit of an item in one status, oldest first. Read phase only. */
export async function readItemUnits(txn: Transaction, itemId: string, status: UnitStatus): Promise<StoredUnit[]> {
  const snap = await txn.get(unitsCollection().where('itemId', '==', itemId).where('status', '==', status))
  return snap.docs
    .map((d) => parseUnit(d.id, d.data() as Record<string, unknown>))
    .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.unitCode.localeCompare(b.unitCode))
}

/**
 * Chooses `quantity` units from `pool`: the requested ones first, then the
 * oldest of the rest. Units carrying their own price are only ever taken when
 * requested by id - otherwise the counter would charge a price nobody saw.
 *
 * Throws UNITS_UNAVAILABLE:<message> when it cannot.
 */
export function pickUnits(
  pool: StoredUnit[],
  quantity: number,
  requestedIds: string[],
  itemName: string,
  options: { allowOverridePrices?: boolean; grade?: UnitGrade } = {}
): StoredUnit[] {
  const byId = new Map(pool.map((u) => [u.id, u]))
  // Picked by quantity, only pieces of the asked-for condition qualify -
  // they all share one price, the one the counter showed.
  const fits = (u: StoredUnit) => !options.grade || u.grade === options.grade
  const chosen: StoredUnit[] = []
  for (const id of requestedIds) {
    const unit = byId.get(id)
    if (!unit) throw new Error(`UNITS_UNAVAILABLE:A scanned ${itemName} is no longer available. Scan it again.`)
    if (!chosen.includes(unit)) chosen.push(unit)
  }
  if (chosen.length > quantity) {
    throw new Error(`UNITS_UNAVAILABLE:More ${itemName} units were scanned than the quantity asked for.`)
  }
  const rest = pool.filter((u) => !chosen.includes(u) && fits(u) && (options.allowOverridePrices || u.priceOverride === null))
  const needed = quantity - chosen.length
  if (rest.length < needed) {
    const priced = pool.filter((u) => !chosen.includes(u) && fits(u) && u.priceOverride !== null).length
    const what = options.grade ? `${itemName} (${options.grade})` : itemName
    throw new Error(
      priced > 0 && !options.allowOverridePrices
        ? `UNITS_UNAVAILABLE:Only ${chosen.length + rest.length} ${what} can be added by quantity. ${priced} more have their own price - scan their labels to add them.`
        : `UNITS_UNAVAILABLE:Only ${chosen.length + rest.length} ${what} are available.`
    )
  }
  return [...chosen, ...rest.slice(0, needed)]
}

/**
 * The units a reservation holds for one item. Read phase only.
 * Uses the unit ids stored on the reservation line; a hold made before the
 * line recorded them falls back to the item's reserved units linked to this
 * reservation. Returns [] when the item has no unit records (quantity only).
 */
export async function readHeldUnits(
  txn: Transaction,
  itemId: string,
  reservationId: string,
  unitIds: string[]
): Promise<StoredUnit[]> {
  if (unitIds.length > 0) {
    const snaps = await Promise.all(unitIds.map((id) => txn.get(unitsCollection().doc(id))))
    return snaps
      .filter((s) => s.exists)
      .map((s) => parseUnit(s.id, s.data() as Record<string, unknown>))
      .filter((u) => u.status === 'reserved' && u.itemId === itemId)
  }
  const snap = await txn.get(
    unitsCollection().where('itemId', '==', itemId).where('reservationId', '==', reservationId)
  )
  return snap.docs
    .map((d) => parseUnit(d.id, d.data() as Record<string, unknown>))
    .filter((u) => u.status === 'reserved')
}

// ── Requests with conditions ────────────────────────────────────────────────

/** Part of an item request: a quantity of one condition, plus any scanned pieces. */
export interface UnitRequestPart {
  grade?: UnitGrade
  quantity: number
  unitIds: string[]
}

/**
 * Reads request lines ({ itemId, quantity, grade?, unitIds? }) into one entry
 * per item, each with its parts. One entry per item matters: the item's count
 * is updated once, however many conditions of it are in the cart.
 */
export function parseItemRequests(lines: unknown[]): Array<{ itemId: string; quantity: number; parts: UnitRequestPart[] }> {
  const byItem = new Map<string, { itemId: string; quantity: number; parts: UnitRequestPart[] }>()
  for (const raw of lines) {
    const r = (raw ?? {}) as Record<string, unknown>
    const itemId = typeof r.itemId === 'string' ? r.itemId.trim() : ''
    const quantity = Math.floor(Number(r.quantity))
    if (!itemId || !Number.isFinite(quantity) || quantity <= 0) continue
    const unitIds = Array.isArray(r.unitIds) ? r.unitIds.filter((v): v is string => typeof v === 'string' && v.length > 0) : []
    const grade = typeof r.grade === 'string' && r.grade ? normalizeUnitGrade(r.grade) : undefined
    const entry = byItem.get(itemId) ?? { itemId, quantity: 0, parts: [] }
    entry.quantity += quantity
    entry.parts.push({ grade, quantity, unitIds })
    byItem.set(itemId, entry)
  }
  return Array.from(byItem.values())
}

/** Picks every part of an item's request from one read of its pool. */
export function pickUnitsForParts(pool: StoredUnit[], parts: UnitRequestPart[], itemName: string): StoredUnit[] {
  let remaining = pool
  const picked: StoredUnit[] = []
  for (const part of parts) {
    const got = pickUnits(remaining, part.quantity, part.unitIds, itemName, { grade: part.grade })
    picked.push(...got)
    remaining = remaining.filter((u) => !got.includes(u))
  }
  return picked
}

// ── Writing ──────────────────────────────────────────────────────────────────

export function setUnitsStatus(
  txn: Transaction,
  units: StoredUnit[],
  status: UnitStatus,
  nowIso: string,
  links: { reservationId?: string | null; saleId?: string | null } = {}
) {
  for (const unit of units) {
    txn.update(unit.ref, {
      status,
      ...(links.reservationId !== undefined ? { reservationId: links.reservationId } : {}),
      ...(links.saleId !== undefined ? { saleId: links.saleId } : {}),
      ...(status === 'sold' ? { soldAt: nowIso } : {}),
      ...(status === 'written_off' ? { writtenOffAt: nowIso } : {}),
      ...(status === 'in_stock' ? { soldAt: null, writtenOffAt: null, reservationId: null } : {}),
      updatedAt: nowIso,
      lastMovedAt: FieldValue.serverTimestamp(),
    })
  }
}

// ── Lines ────────────────────────────────────────────────────────────────────

/** What a piece sells for: its own price, or its condition's share of the base price. */
export const unitPrice = (unit: StoredUnit, basePrice: number, pricing: GradePricing = DEFAULT_GRADE_PRICING) =>
  unit.priceOverride ?? gradePrice(basePrice, unit.grade, pricing)

export const toLineRef = (unit: StoredUnit, price: number): UnitLineRef => ({
  unitId: unit.id,
  unitCode: unit.unitCode,
  grade: unit.grade,
  ...(unit.conditionNotes ? { conditionNotes: unit.conditionNotes } : {}),
  price,
})

/**
 * Splits an item's chosen units into one line per price, highest first.
 * `priceOf` decides each piece's price (condition share now, or the price a
 * reservation locked in). The first line's key is the item id, later ones add
 * the price, so refunds can tell same-item lines apart. Each line carries the
 * New/Refurbished its pieces add up to, for older reports.
 */
export function linesByPrice(itemId: string, units: StoredUnit[], priceOf: (u: StoredUnit) => number) {
  const groups = new Map<number, StoredUnit[]>()
  for (const u of units) {
    const price = priceOf(u)
    groups.set(price, [...(groups.get(price) ?? []), u])
  }
  return Array.from(groups.entries())
    .sort(([a], [b]) => b - a)
    .map(([price, group], i) => ({
      lineKey: i === 0 ? itemId : `${itemId}@${price}`,
      price,
      quantity: group.length,
      units: group,
      unitLines: group.map((u) => toLineRef(u, price)),
      condition: legacyConditionOf(group.map((u) => u.grade)),
    }))
}

/** Short "#00000012, #00000013" list for stock-log remarks. */
export const describeUnits = (units: Array<{ unitCode: string }>) =>
  units.length === 0 ? '' : ` Units: ${units.map((u) => `#${u.unitCode}`).join(', ')}.`
