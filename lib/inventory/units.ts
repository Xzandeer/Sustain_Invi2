// Individual units - one record per physical piece.
//
// ONE CONDITION SCALE
// Every piece has one condition on the surplus grading scale - New,
// Excellent, Very Good, Good, Fair, For parts
// (GRADE_LABEL and GRADE_MEANING below hold the wording staff see). There
// are no separate New and Refurbished item records any more - an item holds all
// of its pieces, whatever their condition, and every piece sells at the item's
// price unless it has a price of its own. New/Refurbished is
// still written on items and sale lines for older reports, derived from the
// pieces: all New = 'New', anything used = 'Refurbished'.
//
// Second-hand goods are rarely identical: two "Rice Cooker - Panasonic" can
// differ in wear, missing parts and what they are worth. An inventory item is
// therefore the PRODUCT LINE (name, category, base price), and each physical
// piece is a UNIT in the `inventoryUnits` collection with its own code,
// condition (`grade`), notes, optional price and history.
//
// TRACKING MODES (per item, `trackingMode` on the inventory document)
//   'unit'      every piece has a unit record. The default for new items.
//   'quantity'  only a count is kept - for identical bulk goods such as a box
//               of new plates, where labelling every piece adds work but no
//               information. Items created before units existed behave as
//               'quantity' until the backfill script (scripts/backfill-units.js)
//               gives them units.
//
// THE ITEM'S COUNTS STAY AUTHORITATIVE FOR TOTALS
// `stock` and `reservedStock` on the item are updated in the same transaction
// as its units, so the dashboard, analytics, low-stock alerts and the forecast
// keep reading the numbers they always read.
//
// This file is shared by the browser and the server; it holds no Firestore code.

export const UNITS_COLLECTION = 'inventoryUnits'

export type TrackingMode = 'unit' | 'quantity'

/** in_stock -> reserved -> sold, or written_off. A refund returns a unit to in_stock. */
export type UnitStatus = 'in_stock' | 'reserved' | 'sold' | 'written_off'

/**
 * The one condition scale, best first. These short ids are what is stored on
 * pieces and sale lines; screens show GRADE_LABEL.
 */
export const UNIT_GRADES = ['New', 'Excellent', 'Very Good', 'Good', 'Fair', 'For parts'] as const
export type UnitGrade = (typeof UNIT_GRADES)[number]

/**
 * "Good ×2, Fair" for a set of pieces, best condition first. Used as the
 * condition of a stock log, so the log shows the pieces that actually moved
 * rather than the item's derived New/Refurbished label.
 */
export function gradeSummary(grades: readonly string[]): string {
  const counts = new Map<string, number>()
  for (const g of grades) if (g) counts.set(g, (counts.get(g) ?? 0) + 1)
  const rank = (g: string) => { const i = (UNIT_GRADES as readonly string[]).indexOf(g); return i < 0 ? 99 : i }
  return Array.from(counts)
    .sort((a, b) => rank(a[0]) - rank(b[0]))
    .map(([g, n]) => (n > 1 ? `${g} ×${n}` : g))
    .join(', ')
}
export const DEFAULT_UNIT_GRADE: UnitGrade = 'Good'

/** What staff see. "Used /" makes new-versus-used plain at a glance. */
export const GRADE_LABEL: Record<UnitGrade, string> = {
  'New': 'New',
  'Excellent': 'Excellent',
  'Very Good': 'Very Good',
  'Good': 'Good',
  'Fair': 'Fair',
  'For parts': 'For parts',
}

/** What each condition means, so two people grade the same piece the same way. */
export const GRADE_MEANING: Record<UnitGrade, string> = {
  'New': 'Never used, usually in its original packaging.',
  'Excellent': 'Barely used, no visible wear.',
  'Very Good': 'Light wear, fully working, no repairs.',
  'Good': 'Visible wear or minor marks, fully working.',
  'Fair': 'Heavy wear, dents or scratches, still usable.',
  'For parts': 'Damaged or not working. Sold as-is.',
}

/** Names used before the surplus scale, read as their current condition. */
const GRADE_ALIASES: Record<string, UnitGrade> = { 'Like new': 'Excellent' }

/** Share of the item's base price each condition sells for, in percent. */
export type GradePricing = Record<UnitGrade, number>
export const DEFAULT_GRADE_PRICING: GradePricing = {
  'New': 100,
  'Excellent': 100,
  'Very Good': 100,
  'Good': 100,
  'Fair': 100,
  'For parts': 100,
}

/**
 * Condition no longer changes the price (the owner's decision): every piece
 * sells at its item's price unless it has a price of its own. Percentages
 * saved earlier are ignored, so old settings cannot bring the discount back.
 */
export const normalizeGradePricing = (_value?: unknown): GradePricing => ({ ...DEFAULT_GRADE_PRICING })


/** A piece's price when it has none of its own: the item's price, whatever its condition. */
export const gradePrice = (basePrice: number, _grade?: UnitGrade, _pricing?: GradePricing) =>
  Math.max(1, Math.round(basePrice))

/**
 * New/Refurbished for older reports, worked out from the pieces' conditions:
 * only unused pieces count as New.
 */
export const legacyConditionOf = (grades: UnitGrade[]): 'New' | 'Refurbished' =>
  grades.length > 0 && grades.every((g) => g === 'New') ? 'New' : 'Refurbished'

/** Colours per condition, shared by every screen that shows one. */
export const GRADE_TONE: Record<UnitGrade, { chip: string; dot: string; bar: string }> = {
  'New':       { chip: 'bg-blue-50 text-blue-700 ring-blue-200',          dot: 'bg-blue-500',    bar: 'bg-blue-500' },
  'Excellent': { chip: 'bg-sky-50 text-sky-700 ring-sky-200',             dot: 'bg-sky-500',     bar: 'bg-sky-400' },
  'Very Good': { chip: 'bg-teal-50 text-teal-700 ring-teal-200',          dot: 'bg-teal-500',    bar: 'bg-teal-500' },
  'Good':      { chip: 'bg-emerald-50 text-emerald-700 ring-emerald-200', dot: 'bg-emerald-500', bar: 'bg-emerald-500' },
  'Fair':      { chip: 'bg-amber-50 text-amber-700 ring-amber-200',       dot: 'bg-amber-500',   bar: 'bg-amber-500' },
  'For parts': { chip: 'bg-red-50 text-red-600 ring-red-200',             dot: 'bg-red-400',     bar: 'bg-red-400' },
}

export const UNIT_STATUS_LABEL: Record<UnitStatus, string> = {
  in_stock: 'In stock',
  reserved: 'Reserved',
  sold: 'Sold',
  written_off: 'Written off',
}

export const normalizeUnitGrade = (value: unknown): UnitGrade =>
  (UNIT_GRADES as readonly string[]).includes(value as string)
    ? (value as UnitGrade)
    : GRADE_ALIASES[value as string] ?? DEFAULT_UNIT_GRADE

export const normalizeTrackingMode = (value: unknown): TrackingMode => (value === 'unit' ? 'unit' : 'quantity')

/** Per-piece details given when stock arrives. Everything is optional. */
export interface UnitDetails {
  grade?: UnitGrade
  conditionNotes?: string
  /** Sells for this instead of the item's price. null/undefined = item price. */
  priceOverride?: number | null
}

/** What a sale, reservation or refund line records about each unit it moved. */
export interface UnitLineRef {
  unitId: string
  unitCode: string
  grade: UnitGrade
  conditionNotes?: string
  price: number
  /** Refunds only: this unit has been returned. */
  refunded?: boolean
}

/** Unit codes are 8 digits, so they never collide with 6-digit item codes. */
export const UNIT_CODE_LENGTH = 8
export const isUnitCode = (code: string) => /^\d{8}$/.test(code)

/** Reads a stored unitLines array defensively. */
export const parseUnitLines = (value: unknown): UnitLineRef[] =>
  Array.isArray(value)
    ? value.flatMap((raw) => {
        const r = (raw ?? {}) as Record<string, unknown>
        const unitId = typeof r.unitId === 'string' ? r.unitId : ''
        if (!unitId) return []
        return [{
          unitId,
          unitCode: typeof r.unitCode === 'string' ? r.unitCode : '',
          grade: normalizeUnitGrade(r.grade),
          ...(typeof r.conditionNotes === 'string' && r.conditionNotes ? { conditionNotes: r.conditionNotes } : {}),
          price: typeof r.price === 'number' && Number.isFinite(r.price) ? r.price : 0,
          ...(r.refunded === true ? { refunded: true } : {}),
        }]
      })
    : []
