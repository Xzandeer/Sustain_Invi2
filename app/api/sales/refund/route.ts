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

import { NextRequest, NextResponse } from 'next/server'
import { FieldValue } from 'firebase-admin/firestore'
import { getAdminDb } from '@/lib/firebaseAdmin'
import { getWarrantyDays } from '@/lib/server/storeSettings'
import { checkPermission, verifiedUid } from '@/lib/server/authorize'
import { getProcessedByInfo } from '@/lib/server/inventory'

interface RequestedLine {
  itemId: string
  quantity: number
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
        ? body.reasonCategory.trim()
        : 'Other'
    const reasonNote = typeof body.reasonNote === 'string' ? body.reasonNote.trim() : ''
    // Backwards compatible with the old free-text `reason` field
    const legacyReason = typeof body.reason === 'string' ? body.reason.trim() : ''
    const reasonText = [reasonCategory, reasonNote || legacyReason].filter(Boolean).join(' — ')

    if (!saleId) {
      return NextResponse.json({ error: 'Missing sale ID' }, { status: 400 })
    }

    const requested: RequestedLine[] = Array.isArray(body.items)
      ? (body.items as Record<string, unknown>[])
          .map((i) => ({
            itemId: typeof i.itemId === 'string' ? i.itemId : '',
            quantity: Math.floor(typeof i.quantity === 'number' ? i.quantity : Number(i.quantity) || 0),
          }))
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
      const currentStatus = typeof saleData.status === 'string' ? saleData.status.toLowerCase() : 'completed'
      if (currentStatus === 'refunded') throw new RefundError('This sale has already been fully refunded.')
      if (currentStatus === 'voided') throw new RefundError('Voided sales cannot be refunded.')

      const receiptNumber = typeof saleData.receiptNumber === 'string' ? saleData.receiptNumber : saleId

      // Sale lines, including any quantity refunded by previous partial refunds
      const saleLines = (Array.isArray(saleData.items) ? saleData.items : []).map((raw) => {
        const item = raw as Record<string, unknown>
        return {
          // Everything else on the line is carried through untouched - the
          // sale is rewritten from these lines, and a dropped field is lost.
          raw: item,
          itemId: typeof item.itemId === 'string' ? item.itemId : '',
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
      const toRefund: Array<{ itemId: string; name: string; quantity: number; price: number; condition?: string }> = []
      if (isPartial) {
        for (const r of requested) {
          const line = saleLines.find((l) => l.itemId === r.itemId)
          if (!line) throw new RefundError(`Item ${r.itemId} is not part of this sale.`)
          const already = toRefund.filter((t) => t.itemId === line.itemId).reduce((s, t) => s + t.quantity, 0)
          const remaining = line.quantity - line.refundedQuantity - already
          if (r.quantity > remaining) {
            throw new RefundError(`Cannot refund ${r.quantity} of "${line.name}" — only ${Math.max(0, remaining)} remain${remaining === 1 ? 's' : ''} refundable.`)
          }
          toRefund.push({ itemId: line.itemId, name: line.name, quantity: r.quantity, price: line.price, condition: line.condition })
        }
      } else {
        // Full refund — everything not yet refunded
        for (const line of saleLines) {
          const remaining = line.quantity - line.refundedQuantity
          if (remaining > 0) {
            toRefund.push({ itemId: line.itemId, name: line.name, quantity: remaining, price: line.price, condition: line.condition })
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

      // ── 4. Read every item coming back (all reads before writes) ─────────
      const itemIds = Array.from(new Set(toRefund.map((l) => l.itemId).filter(Boolean)))
      const itemSnaps = await Promise.all(itemIds.map((id) => txn.get(adminDb.collection('inventory').doc(id))))

      // ── 5. Restock each item once, and log each line ─────────────────────
      const nowIso = new Date().toISOString()
      const running = new Map<string, { stock: number; reserved: number; condition: unknown }>()
      for (const snap of itemSnaps) {
        if (!snap.exists) continue
        const d = snap.data() as Record<string, unknown>
        running.set(snap.id, {
          stock: typeof d.stock === 'number' ? d.stock : 0,
          reserved: typeof d.reservedStock === 'number' ? d.reservedStock : 0,
          condition: d.condition,
        })
      }
      for (const line of toRefund) {
        const cur = running.get(line.itemId)
        if (!cur) continue // item deleted since; the money is still refunded
        const stockBefore = cur.stock
        const stockAfter = stockBefore + line.quantity
        cur.stock = stockAfter
        txn.set(adminDb.collection('stockLogs').doc(), {
          createdAt: FieldValue.serverTimestamp(),
          actionType: 'sale_refund',
          itemId: line.itemId,
          itemName: line.name,
          condition: line.condition ?? cur.condition ?? 'New',
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
          remarks: `Refund – ${receiptNumber}: ${reasonText}`,
          refundReasonCategory: reasonCategory,
          referenceId: receiptNumber,
          referenceType: 'refund',
          relatedId: saleId,
        })
      }
      for (const [id, cur] of running) {
        txn.update(adminDb.collection('inventory').doc(id), { stock: cur.stock, quantity: cur.stock, updatedAt: nowIso })
      }

      // ── 6. Update the sale ───────────────────────────────────────────────
      const updatedItems = saleLines.map((line) => {
        const refundedQty = toRefund.filter((r) => r.itemId === line.itemId).reduce((s, r) => s + r.quantity, 0)
        return {
          ...line.raw,
          itemId: line.itemId,
          name: line.name,
          quantity: line.quantity,
          price: line.price,
          ...(line.condition ? { condition: line.condition } : {}),
          ...(line.categoryId ? { categoryId: line.categoryId } : {}),
          ...(line.categoryName ? { categoryName: line.categoryName } : {}),
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

      return { fullyRefunded, refundAmount, lines: toRefund.map((l) => ({ name: l.name, quantity: l.quantity })) }
    })

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
