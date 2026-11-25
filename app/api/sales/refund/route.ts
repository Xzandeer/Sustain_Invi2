// Refund API
//
// Supports BOTH:
//   • Full refund   — omit `items` (or pass every line at full quantity)
//   • Partial refund — pass `items: [{ itemId, quantity }]` to return only part of a sale
//
// Rules enforced here:
//   1. The sale must exist and must not be voided or already fully refunded.
//   2. The refund must fall within the store's warranty window (Settings → Store Policy).
//   3. Refunded quantity per line can never exceed what was sold, minus what was
//      already refunded in earlier partial refunds.
//   4. A discounted sale refunds what the customer actually paid: each line's
//      price is scaled by total / subtotal.
//
// Side effects: restocks inventory, writes a `sale_refund` stock log per line,
// and updates the sale's status to 'refunded' (full) or 'partially_refunded'.
//
// Everything happens in ONE transaction that reads the sale first. Two refunds
// of the same sale at once (a double tap, or two counters) used to both pass
// the "how much is left" check, since the sale was read outside any
// transaction; now the second one re-reads the sale after the first commits
// and is refused if nothing is left.
//
// Unit-tracked lines (lib/inventory/units.ts): the returned pieces go back on
// the shelf as the same records, with the same codes and labels. A request may
// name them with unitIds; otherwise the first pieces not yet returned are used.
// Lines are matched by lineKey, so two lines of one item at different prices
// (a piece with its own price) are told apart.

import { INPUT_LIMITS } from '@/lib/constants/limits'
import { NextRequest, NextResponse } from 'next/server'
import { FieldValue } from 'firebase-admin/firestore'
import { getAdminDb } from '@/lib/firebaseAdmin'
import { getWarrantyDays } from '@/lib/server/storeSettings'
import { checkPermission, verifiedUid } from '@/lib/server/authorize'
import { gradeSummary, parseUnitLines, type UnitLineRef } from '@/lib/inventory/units'
import { setUnitsStatus, unitsCollection, parseUnit } from '@/lib/server/units'
import { getProcessedByInfo } from '@/lib/server/inventory'
import { forget } from '@/lib/server/readCache'

interface RequestedLine {
  itemId: string
  /** Which line of the sale; defaults to the item id. */
  lineKey: string
  quantity: number
  unitIds: string[]
}

/** A refusal raised inside the transaction, returned to the caller as is. */
class RefundError extends Error {
  constructor(message: string, public status = 400) { super(message) }
}

const round2 = (n: number) => Math.round(n * 100) / 100

export async function POST(req: NextRequest) {
  try {
    // ── 0. Permission check first — enforced server-side, not just in the UI ─
    const authz = await checkPermission(await verifiedUid(req), 'canProcessRefunds')
    if (!authz.allowed) {
      return NextResponse.json({ error: authz.reason ?? 'Not permitted.' }, { status: authz.reason?.includes('signed in') ? 401 : 403 })
    }

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const saleId = typeof body.saleId === 'string' ? body.saleId.trim() : ''

    const reasonCategory =
      typeof body.reasonCategory === 'string' && body.reasonCategory.trim()
        ? body.reasonCategory.trim().slice(0, INPUT_LIMITS.name)
        : 'Other'
    const reasonNote =
      typeof body.reasonNote === 'string' ? body.reasonNote.trim().slice(0, INPUT_LIMITS.note) : ''
    // Backwards compatible with the old free-text `reason` field
    const legacyReason = typeof body.reason === 'string' ? body.reason.trim().slice(0, INPUT_LIMITS.note) : ''
    const reasonText = [reasonCategory, reasonNote || legacyReason]
      .filter(Boolean)
      .join(' — ')

    if (!saleId) {
      return NextResponse.json({ error: 'Missing sale ID' }, { status: 400 })
    }

    const requested: RequestedLine[] = Array.isArray(body.items)
      ? (body.items as Record<string, unknown>[])
          .map((i) => {
            const itemId = typeof i.itemId === 'string' ? i.itemId : ''
            return {
              itemId,
              lineKey: typeof i.lineKey === 'string' && i.lineKey ? i.lineKey : itemId,
              quantity: Math.floor(
                typeof i.quantity === 'number' ? i.quantity : Number(i.quantity) || 0
              ),
              unitIds: Array.isArray(i.unitIds) ? i.unitIds.filter((v): v is string => typeof v === 'string') : [],
            }
          })
          .filter((i) => i.itemId && i.quantity > 0)
      : []
    const isPartial = requested.length > 0

    // Who is refunding: the signed-in account, recorded on each stock log.
    const actor = await getProcessedByInfo(req)
    // Store policy, for older sales that predate the warranty snapshot.
    const policyWarrantyDays = await getWarrantyDays()

    const adminDb = getAdminDb()
    const saleRef = adminDb.collection('sales').doc(saleId)

    const result = await adminDb.runTransaction(async (txn) => {
      // ── 1. Load the sale (inside the transaction) ─────────────────────────
      const saleSnap = await txn.get(saleRef)
      if (!saleSnap.exists) throw new RefundError('Sale not found', 404)

      const saleData = saleSnap.data() as Record<string, unknown>
      const currentStatus =
        typeof saleData.status === 'string' ? saleData.status.toLowerCase() : 'completed'
      if (currentStatus === 'refunded') throw new RefundError('This sale has already been fully refunded.')
      if (currentStatus === 'voided') throw new RefundError('Voided sales cannot be refunded.')

      const receiptNumber =
        typeof saleData.receiptNumber === 'string' ? saleData.receiptNumber : saleId

      // Sale lines, including any quantity refunded by previous partial refunds
      const saleLines = (Array.isArray(saleData.items) ? saleData.items : []).map((raw) => {
        const item = raw as Record<string, unknown>
        const itemId = typeof item.itemId === 'string' ? item.itemId : ''
        return {
          // Everything else on the line is carried through untouched - the
          // sale is rewritten from these lines, and a dropped field is lost.
          raw: item,
          itemId,
          lineKey: typeof item.lineKey === 'string' && item.lineKey ? item.lineKey : itemId,
          unitLines: parseUnitLines(item.unitLines),
          name: typeof item.name === 'string' ? item.name : 'Unknown Item',
          quantity: typeof item.quantity === 'number' ? item.quantity : 1,
          price: typeof item.price === 'number' ? item.price : 0,
          condition: typeof item.condition === 'string' ? item.condition : undefined,
          // Category must be carried through - Analytics groups by categoryId.
          categoryId: typeof item.categoryId === 'string' ? item.categoryId : undefined,
          categoryName: typeof item.categoryName === 'string' ? item.categoryName : undefined,
          refundedQuantity: typeof item.refundedQuantity === 'number' ? item.refundedQuantity : 0,
        }
      })

      // ── 2. Warranty window check ─────────────────────────────────────────
      const snapshotDays =
        typeof saleData.warrantyDays === 'number'
          ? saleData.warrantyDays
          : (() => {
              const first = (Array.isArray(saleData.items) ? saleData.items : [])[0] as Record<string, unknown> | undefined
              return typeof first?.warrantyDays === 'number' ? first.warrantyDays : null
            })()
      const warrantyDays = snapshotDays ?? policyWarrantyDays
      const saleDate = (() => {
        const iso = saleData.transactionDate
        if (typeof iso === 'string') {
          const t = Date.parse(iso)
          if (!Number.isNaN(t)) return new Date(t)
        }
        const raw = saleData.createdAt as { seconds?: number } | undefined
        if (raw && typeof raw === 'object' && typeof raw.seconds === 'number') return new Date(raw.seconds * 1000)
        return null
      })()
      if (saleDate) {
        const daysSinceSale = (Date.now() - saleDate.getTime()) / (1000 * 60 * 60 * 24)
        if (daysSinceSale > warrantyDays) {
          throw new RefundError(
            `Refund period has expired. This sale was completed ${Math.floor(daysSinceSale)} day(s) ago, and the warranty window is ${warrantyDays} day(s).`
          )
        }
      }

      // ── 3. Resolve which lines to refund ─────────────────────────────────
      const toRefund: Array<{
        itemId: string; lineKey: string; name: string; quantity: number; price: number; condition?: string
        /** Unit-tracked lines: the pieces coming back. */
        units: UnitLineRef[]
      }> = []

      // The pieces of a line still with the customer, named ones first.
      const returningUnits = (line: (typeof saleLines)[number], quantity: number, named: string[]) => {
        if (line.unitLines.length === 0) return []
        const out = line.unitLines.filter((u) => !u.refunded)
        const chosen = [...out.filter((u) => named.includes(u.unitId)), ...out.filter((u) => !named.includes(u.unitId))]
        return chosen.slice(0, quantity)
      }

      if (isPartial) {
        for (const r of requested) {
          const line =
            saleLines.find((l) => l.lineKey === r.lineKey) ??
            saleLines.find((l) => l.itemId === r.itemId && l.quantity - l.refundedQuantity > 0)
          if (!line) throw new RefundError(`Item ${r.itemId} is not part of this sale.`)
          const already = toRefund.filter((t) => t.lineKey === line.lineKey).reduce((s, t) => s + t.quantity, 0)
          const remaining = line.quantity - line.refundedQuantity - already
          if (r.quantity > remaining) {
            throw new RefundError(`Cannot refund ${r.quantity} of "${line.name}" — only ${Math.max(0, remaining)} remain${remaining === 1 ? 's' : ''} refundable.`)
          }
          toRefund.push({ itemId: line.itemId, lineKey: line.lineKey, name: line.name, quantity: r.quantity, price: line.price, condition: line.condition, units: returningUnits(line, r.quantity, r.unitIds) })
        }
      } else {
        // Full refund — everything not yet refunded
        for (const line of saleLines) {
          const remaining = line.quantity - line.refundedQuantity
          if (remaining > 0) {
            toRefund.push({ itemId: line.itemId, lineKey: line.lineKey, name: line.name, quantity: remaining, price: line.price, condition: line.condition, units: returningUnits(line, remaining, []) })
          }
        }
      }
      if (toRefund.length === 0) throw new RefundError('There is nothing left to refund on this sale.')

      // What the customer paid per peso of list price (a discount lowers it).
      const subtotal = typeof saleData.subtotal === 'number' && saleData.subtotal > 0
        ? saleData.subtotal
        : saleLines.reduce((s, l) => s + l.price * l.quantity, 0)
      const total = typeof saleData.totalAmount === 'number' ? saleData.totalAmount : subtotal
      const paidShare = subtotal > 0 ? Math.min(1, total / subtotal) : 1
      const previousRefundTotal = typeof saleData.refundedAmount === 'number' ? saleData.refundedAmount : 0
      const refundAmount = Math.min(
        round2(toRefund.reduce((sum, l) => sum + l.price * l.quantity, 0) * paidShare),
        round2(total - previousRefundTotal),
      )

      // ── 4. Read every item and piece coming back (all reads before writes) ─
      const itemIds = Array.from(new Set(toRefund.map((l) => l.itemId).filter(Boolean)))
      // A sale paid from a reservation whose goods are still in the shop: a
      // full refund ends that hold, or it would sit as "awaiting collection"
      // for goods the customer has had their money back for.
      const sourceReservationId = typeof saleData.sourceReservationId === 'string' ? saleData.sourceReservationId : ''
      const holdSnap = sourceReservationId ? await txn.get(adminDb.collection('reservations').doc(sourceReservationId)) : null
      const itemSnaps = new Map(
        (await Promise.all(itemIds.map((id) => txn.get(adminDb.collection('inventory').doc(id))))).map((s) => [s.id, s])
      )
      const unitIds = toRefund.flatMap((l) => l.units.map((u) => u.unitId))
      const unitSnaps = await Promise.all(unitIds.map((id) => txn.get(unitsCollection().doc(id))))
      const soldUnits = unitSnaps
        .filter((us) => us.exists)
        .map((us) => parseUnit(us.id, us.data() as Record<string, unknown>))
        .filter((u) => u.status === 'sold')

      // ── 5. Restock each item once, and log each line ─────────────────────
      const nowIso = new Date().toISOString()
      const running = new Map<string, { stock: number; reserved: number; condition: unknown; offSale: boolean }>()
      for (const id of itemIds) {
        const snap = itemSnaps.get(id)
        if (!snap?.exists) continue
        const d = snap.data() as Record<string, unknown>
        running.set(id, {
          stock: typeof d.stock === 'number' ? d.stock : 0,
          reserved: typeof d.reservedStock === 'number' ? d.reservedStock : 0,
          condition: d.condition,
          // Written off or in the Trash since the sale.
          offSale: d.isVoided === true || d.isDeleted === true,
        })
      }
      for (const line of toRefund) {
        const cur = running.get(line.itemId)
        if (!cur) continue // item deleted since; the money is still refunded
        const stockBefore = cur.stock
        const stockAfter = stockBefore + line.quantity
        cur.stock = stockAfter
        const lineUnits = soldUnits.filter((u) => line.units.some((r) => r.unitId === u.id))
        setUnitsStatus(txn, lineUnits, 'in_stock', nowIso, { saleId: null })
        for (const u of lineUnits) txn.update(u.ref, { lastSaleId: saleId, returnedAt: nowIso })
        txn.set(adminDb.collection('stockLogs').doc(), {
          createdAt: FieldValue.serverTimestamp(),
          actionType: 'sale_refund',
          itemId: line.itemId,
          itemName: line.name,
          // The returned pieces' own conditions when known ("Good ×2").
          condition: lineUnits.length ? gradeSummary(lineUnits.map((u) => u.grade)) : (line.condition ?? cur.condition ?? 'New'),
          quantityBefore: stockBefore,
          quantityChanged: line.quantity,
          quantityAfter: stockAfter,
          stockBefore,
          stockAfter,
          reservedBefore: cur.reserved,
          reservedAfter: cur.reserved,
          userName: actor.name,
          userEmail: actor.email ?? '',
          userId: actor.uid ?? '',
          remarks: `Refund – ${receiptNumber}: ${reasonText}` +
            (lineUnits.length ? ` Units back on the shelf: ${lineUnits.map((u) => '#' + u.unitCode).join(', ')}.` : '') +
            (cur.offSale ? ' The item had been written off or deleted; it is back on sale with the returned pieces.' : ''),
          ...(lineUnits.length ? { unitIds: lineUnits.map((u) => u.id), unitCodes: lineUnits.map((u) => u.unitCode), unitGrades: lineUnits.map((u) => u.grade) } : {}),
          refundReasonCategory: reasonCategory,
          referenceId: receiptNumber,
          referenceType: 'refund',
          relatedId: saleId,
        })
      }
      for (const [id, cur] of running) {
        txn.update(adminDb.collection('inventory').doc(id), {
          stock: cur.stock, quantity: cur.stock, updatedAt: nowIso,
          // Returned pieces are on the shelf again, so the item is back on
          // sale. Left written off or deleted, they were counted as stock but
          // hidden from Inventory and Sales. Earlier write-offs stay recorded
          // (voidedUnits), as for an item that is partly written off.
          ...(cur.offSale ? { isVoided: false, isDeleted: false, deletedAt: null, restoredAt: nowIso } : {}),
        })
      }

      // ── 6. Update the sale ───────────────────────────────────────────────
      const updatedItems = saleLines.map((line) => {
        const refundedQty = toRefund.filter((r) => r.lineKey === line.lineKey).reduce((s, r) => s + r.quantity, 0)
        const returned = new Set(toRefund.filter((r) => r.lineKey === line.lineKey).flatMap((r) => r.units.map((u) => u.unitId)))
        return {
          ...line.raw,
          itemId: line.itemId,
          name: line.name,
          quantity: line.quantity,
          price: line.price,
          ...(line.condition ? { condition: line.condition } : {}),
          ...(line.categoryId ? { categoryId: line.categoryId } : {}),
          ...(line.categoryName ? { categoryName: line.categoryName } : {}),
          ...(line.unitLines.length
            ? { unitLines: line.unitLines.map((u) => (returned.has(u.unitId) ? { ...u, refunded: true } : u)) }
            : {}),
          refundedQuantity: line.refundedQuantity + refundedQty,
        }
      })
      const fullyRefunded = updatedItems.every((l) => l.refundedQuantity >= l.quantity)
      txn.update(saleRef, {
        items: updatedItems,
        status: fullyRefunded ? 'refunded' : 'partially_refunded',
        refundedAt: FieldValue.serverTimestamp(),
        refundReason: reasonText,
        refundReasonCategory: reasonCategory,
        refundedAmount: round2(previousRefundTotal + refundAmount),
      })
      if (fullyRefunded && holdSnap?.exists && (holdSnap.data() as Record<string, unknown>).status === 'AwaitingCollection') {
        txn.update(holdSnap.ref, {
          status: 'Cancelled',
          cancellationReason: `Refunded before collection (${receiptNumber})`,
          cancellationReasonType: 'system',
          cancelledBy: actor.name,
          cancelledAt: nowIso,
          updatedAt: nowIso,
        })
      }

      return { fullyRefunded, refundAmount, lines: toRefund.map((l) => ({ name: l.name, quantity: l.quantity })) }
    })

    // A refund changes a past sale: remembered sales reads are out of date.
    forget('sales:')
    return NextResponse.json({
      success: true,
      partial: !result.fullyRefunded,
      refundedAmount: result.refundAmount,
      refundedLines: result.lines,
      status: result.fullyRefunded ? 'refunded' : 'partially_refunded',
    })
  } catch (err) {
    if (err instanceof RefundError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    console.error('Refund error:', err)
    return NextResponse.json({ error: 'Failed to process refund' }, { status: 500 })
  }
}
