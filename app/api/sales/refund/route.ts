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
//
// Side effects: restocks inventory, writes a `sale_refund` stock log per line,
// and updates the sale's status to 'refunded' (full) or 'partially_refunded'.

import { NextRequest, NextResponse } from 'next/server'
import {
  doc,
  getDoc,
  runTransaction,
  serverTimestamp,
  addDoc,
  collection,
} from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { getWarrantyDays } from '@/lib/server/storeSettings'
import { checkPermission } from '@/lib/server/authorize'

interface RequestedLine {
  itemId: string
  quantity: number
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const saleId = typeof body.saleId === 'string' ? body.saleId.trim() : ''

    const reasonCategory =
      typeof body.reasonCategory === 'string' && body.reasonCategory.trim()
        ? body.reasonCategory.trim()
        : 'Other'
    const reasonNote =
      typeof body.reasonNote === 'string' ? body.reasonNote.trim() : ''
    // Backwards compatible with the old free-text `reason` field
    const legacyReason = typeof body.reason === 'string' ? body.reason.trim() : ''
    const reasonText = [reasonCategory, reasonNote || legacyReason]
      .filter(Boolean)
      .join(' — ')

    if (!saleId) {
      return NextResponse.json({ error: 'Missing sale ID' }, { status: 400 })
    }

    // ── 0. Permission check — enforced server-side, not just in the UI ─────
    const requestedBy = typeof body.requestedByUid === 'string' ? body.requestedByUid : ''
    if (requestedBy) {
      const authz = await checkPermission(requestedBy, 'canProcessRefunds')
      if (!authz.allowed) {
        return NextResponse.json({ error: authz.reason ?? 'Not permitted.' }, { status: 403 })
      }
    }

    // ── 1. Load the sale ───────────────────────────────────────────────────
    const saleRef = doc(db, 'sales', saleId)
    const saleSnap = await getDoc(saleRef)
    if (!saleSnap.exists()) {
      return NextResponse.json({ error: 'Sale not found' }, { status: 404 })
    }

    const saleData = saleSnap.data() as Record<string, unknown>
    const currentStatus =
      typeof saleData.status === 'string' ? saleData.status.toLowerCase() : 'completed'

    if (currentStatus === 'refunded') {
      return NextResponse.json(
        { error: 'This sale has already been fully refunded.' },
        { status: 400 }
      )
    }
    if (currentStatus === 'voided') {
      return NextResponse.json(
        { error: 'Voided sales cannot be refunded.' },
        { status: 400 }
      )
    }

    const receiptNumber =
      typeof saleData.receiptNumber === 'string' ? saleData.receiptNumber : saleId

    // Sale lines, including any quantity refunded by previous partial refunds
    const saleLines = (Array.isArray(saleData.items) ? saleData.items : []).map(
      (raw) => {
        const item = raw as Record<string, unknown>
        return {
          itemId: typeof item.itemId === 'string' ? item.itemId : '',
          name: typeof item.name === 'string' ? item.name : 'Unknown Item',
          quantity: typeof item.quantity === 'number' ? item.quantity : 1,
          price: typeof item.price === 'number' ? item.price : 0,
          condition: typeof item.condition === 'string' ? item.condition : undefined,
          refundedQuantity:
            typeof item.refundedQuantity === 'number' ? item.refundedQuantity : 0,
        }
      }
    )

    // ── 2. Warranty window check ───────────────────────────────────────────
    // Use the window that was promised to the customer on the day of sale.
    // Older sales predating this field fall back to the current store policy.
    const snapshotDays =
      typeof saleData.warrantyDays === 'number'
        ? saleData.warrantyDays
        : (() => {
            const first = (Array.isArray(saleData.items) ? saleData.items : [])[0] as
              | Record<string, unknown>
              | undefined
            return typeof first?.warrantyDays === 'number' ? first.warrantyDays : null
          })()

    const warrantyDays = snapshotDays ?? (await getWarrantyDays())
    const saleDate = (() => {
      const iso = saleData.transactionDate
      if (typeof iso === 'string') {
        const t = Date.parse(iso)
        if (!Number.isNaN(t)) return new Date(t)
      }
      const raw = saleData.createdAt as { seconds?: number } | undefined
      if (raw && typeof raw === 'object' && typeof raw.seconds === 'number') {
        return new Date(raw.seconds * 1000)
      }
      return null
    })()

    if (saleDate) {
      const daysSinceSale =
        (Date.now() - saleDate.getTime()) / (1000 * 60 * 60 * 24)
      if (daysSinceSale > warrantyDays) {
        return NextResponse.json(
          {
            error: `Refund period has expired. This sale was completed ${Math.floor(
              daysSinceSale
            )} day(s) ago, and the warranty window is ${warrantyDays} day(s).`,
          },
          { status: 400 }
        )
      }
    }

    // ── 3. Resolve which lines to refund ───────────────────────────────────
    const requested: RequestedLine[] = Array.isArray(body.items)
      ? (body.items as Record<string, unknown>[])
          .map((i) => ({
            itemId: typeof i.itemId === 'string' ? i.itemId : '',
            quantity: Math.floor(
              typeof i.quantity === 'number' ? i.quantity : Number(i.quantity) || 0
            ),
          }))
          .filter((i) => i.itemId && i.quantity > 0)
      : []

    const isPartial = requested.length > 0

    // Build the definitive refund list, validating against remaining quantity
    const toRefund: Array<{
      itemId: string
      name: string
      quantity: number
      price: number
      condition?: string
    }> = []

    if (isPartial) {
      for (const r of requested) {
        const line = saleLines.find((l) => l.itemId === r.itemId)
        if (!line) {
          return NextResponse.json(
            { error: `Item ${r.itemId} is not part of this sale.` },
            { status: 400 }
          )
        }
        const remaining = line.quantity - line.refundedQuantity
        if (r.quantity > remaining) {
          return NextResponse.json(
            {
              error: `Cannot refund ${r.quantity} of "${line.name}" — only ${remaining} remain${
                remaining === 1 ? 's' : ''
              } refundable.`,
            },
            { status: 400 }
          )
        }
        toRefund.push({
          itemId: line.itemId,
          name: line.name,
          quantity: r.quantity,
          price: line.price,
          condition: line.condition,
        })
      }
    } else {
      // Full refund — everything not yet refunded
      for (const line of saleLines) {
        const remaining = line.quantity - line.refundedQuantity
        if (remaining > 0) {
          toRefund.push({
            itemId: line.itemId,
            name: line.name,
            quantity: remaining,
            price: line.price,
            condition: line.condition,
          })
        }
      }
    }

    if (toRefund.length === 0) {
      return NextResponse.json(
        { error: 'There is nothing left to refund on this sale.' },
        { status: 400 }
      )
    }

    const refundAmount = toRefund.reduce((sum, l) => sum + l.price * l.quantity, 0)

    // ── 4. Restock each refunded line and log it ───────────────────────────
    for (const line of toRefund) {
      if (!line.itemId) continue
      const itemRef = doc(db, 'inventory', line.itemId)

      await runTransaction(db, async (txn) => {
        const itemSnap = await txn.get(itemRef)
        if (!itemSnap.exists()) return

        const itemData = itemSnap.data() as Record<string, unknown>
        const stockBefore = typeof itemData.stock === 'number' ? itemData.stock : 0
        const stockAfter = stockBefore + line.quantity

        txn.update(itemRef, { stock: stockAfter })

        await addDoc(collection(db, 'stockLogs'), {
          createdAt: serverTimestamp(),
          actionType: 'sale_refund',
          itemId: line.itemId,
          itemName: line.name,
          condition: line.condition ?? itemData.condition ?? 'New',
          quantityBefore: stockBefore,
          quantityChanged: line.quantity,
          quantityAfter: stockAfter,
          stockBefore,
          stockAfter,
          reservedBefore:
            typeof itemData.reservedStock === 'number' ? itemData.reservedStock : 0,
          reservedAfter:
            typeof itemData.reservedStock === 'number' ? itemData.reservedStock : 0,
          remarks: `Refund – ${receiptNumber}: ${reasonText}`,
          refundReasonCategory: reasonCategory,
          referenceId: receiptNumber,
          referenceType: 'refund',
        })
      })
    }

    // ── 5. Update the sale document ────────────────────────────────────────
    const updatedItems = saleLines.map((line) => {
      const refunded = toRefund.find((r) => r.itemId === line.itemId)
      return {
        itemId: line.itemId,
        name: line.name,
        quantity: line.quantity,
        price: line.price,
        ...(line.condition ? { condition: line.condition } : {}),
        refundedQuantity: line.refundedQuantity + (refunded?.quantity ?? 0),
      }
    })

    const fullyRefunded = updatedItems.every(
      (l) => l.refundedQuantity >= l.quantity
    )
    const previousRefundTotal =
      typeof saleData.refundedAmount === 'number' ? saleData.refundedAmount : 0

    await runTransaction(db, async (txn) => {
      txn.update(saleRef, {
        items: updatedItems,
        status: fullyRefunded ? 'refunded' : 'partially_refunded',
        refundedAt: serverTimestamp(),
        refundReason: reasonText,
        refundReasonCategory: reasonCategory,
        refundedAmount: previousRefundTotal + refundAmount,
      })
    })

    return NextResponse.json({
      success: true,
      partial: !fullyRefunded,
      refundedAmount: refundAmount,
      refundedLines: toRefund.map((l) => ({ name: l.name, quantity: l.quantity })),
      status: fullyRefunded ? 'refunded' : 'partially_refunded',
    })
  } catch (err) {
    console.error('Refund error:', err)
    return NextResponse.json({ error: 'Failed to process refund' }, { status: 500 })
  }
}
