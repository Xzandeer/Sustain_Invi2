// What a reservation holds, line by line, with each piece's condition.
//
// A stored reservation item is one line per product (the hold, claim and
// release code updates each item once), with the exact pieces in `unitLines`.
// Shown as is, a hold of one Good and one Fair piece read as "2 × New price".
// This splits it back into one line per condition and price, the way the
// ticket printed it and the way the sale will charge it.
//
// Items tracked by count (no pieces) keep their one line and item condition.

import { GRADE_LABEL, UNIT_GRADES, parseUnitLines, type UnitGrade } from '@/lib/inventory/units'

export interface HeldLine {
  /** Unique within the reservation (item id, plus condition and price when split). */
  key: string
  /** The inventory item. */
  id: string
  name: string
  quantity: number
  price: number
  /** The pieces' condition, or the item's condition for count-tracked items. */
  condition: string
  grade?: UnitGrade
  /** Piece labels on this line, e.g. ["00000012"]. */
  unitCodes: string[]
}

const toNum = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0)

/** One stored reservation item, as lines per condition and price. */
export function heldLines(raw: unknown): HeldLine[] {
  const r = (raw ?? {}) as Record<string, unknown>
  const id = typeof r.id === 'string' ? r.id : ''
  const name = typeof r.name === 'string' ? r.name.trim() : ''
  const quantity = Math.max(0, Math.floor(toNum(r.quantity)))
  const price = Math.max(0, toNum(r.price))
  const condition = typeof r.condition === 'string' && r.condition ? r.condition : 'New'
  if (!id || !name || quantity <= 0) return []

  const pieces = parseUnitLines(r.unitLines)
  if (pieces.length === 0) return [{ key: id, id, name, quantity, price, condition, unitCodes: [] }]

  const groups = new Map<string, HeldLine>()
  for (const p of pieces) {
    const k = `${p.grade}@${p.price}`
    const line = groups.get(k) ?? { key: `${id}:${k}`, id, name, quantity: 0, price: p.price, condition: GRADE_LABEL[p.grade] ?? p.grade, grade: p.grade, unitCodes: [] }
    line.quantity += 1
    if (p.unitCode) line.unitCodes.push(p.unitCode)
    groups.set(k, line)
  }
  const lines = Array.from(groups.values())
    .sort((a, b) => UNIT_GRADES.indexOf(a.grade!) - UNIT_GRADES.indexOf(b.grade!) || b.price - a.price)

  // Older holds may list fewer pieces than their quantity; keep the rest.
  const rest = quantity - pieces.length
  if (rest > 0) lines.push({ key: `${id}:rest`, id, name, quantity: rest, price, condition, unitCodes: [] })
  return lines
}

/** Every line of a reservation's stored items. */
export const heldLinesOf = (items: unknown): HeldLine[] =>
  Array.isArray(items) ? items.flatMap(heldLines) : []

/** "Good ×2, Fair" - the conditions held, for one-line summaries. */
export function conditionSummary(lines: Array<{ condition: string; quantity: number }>): string {
  const byCondition = new Map<string, number>()
  for (const l of lines) byCondition.set(l.condition, (byCondition.get(l.condition) ?? 0) + l.quantity)
  return Array.from(byCondition, ([c, n]) => (n > 1 ? `${c} ×${n}` : c)).join(', ')
}
