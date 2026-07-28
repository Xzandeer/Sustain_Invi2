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
import { WARRANTY_DAYS } from '@/lib/constants/warranty'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>
    const saleId = typeof body.saleId === 'string' ? body.saleId.trim() : ''
    const reason = typeof body.reason === 'string' && body.reason.trim()
      ? body.reason.trim()
      : 'Refund processed'

    if (!saleId) return NextResponse.json({ error: 'Missing sale ID' }, { status: 400 })

    // 1. Load the sale
    const saleRef = doc(db, 'sales', saleId)
    const saleSnap = await getDoc(saleRef)
    if (!saleSnap.exists()) {
      return NextResponse.json({ error: 'Sale not found' }, { status: 404 })
    }

    const saleData = saleSnap.data() as Record<string, unknown>
    const currentStatus = typeof saleData.status === 'string' ? saleData.status : 'completed'

    if (currentStatus === 'refunded') {
      return NextResponse.json({ error: 'Sale has already been refunded' }, { status: 400 })
    }
    if (currentStatus === 'voided') {
      return NextResponse.json({ error: 'Voided sales cannot be refunded' }, { status: 400 })
    }

    const receiptNumber =
      typeof saleData.receiptNumber === 'string' ? saleData.receiptNumber : saleId

    const items: Array<{
      itemId?: string
      name: string
      quantity: number
      condition?: string
      warrantyDays?: number
    }> = Array.isArray(saleData.items)
      ? (saleData.items as Record<string, unknown>[]).map((item) => ({
          itemId: typeof item.itemId === 'string' ? item.itemId : undefined,
          name: typeof item.name === 'string' ? item.name : 'Unknown Item',
          quantity: typeof item.quantity === 'number' ? item.quantity : 1,
          condition: typeof item.condition === 'string' ? item.condition : undefined,
          warrantyDays: typeof item.warrantyDays === 'number' ? item.warrantyDays : undefined,
        }))
      : []

    // ── Warranty check: refund only allowed within the warranty window ──
    // Sale date comes from transactionDate (ISO) or createdAt (Firestore Timestamp).
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
      const daysSinceSale = (Date.now() - saleDate.getTime()) / (1000 * 60 * 60 * 24)
      if (daysSinceSale > WARRANTY_DAYS) {
        return NextResponse.json(
          {
            error: `Refund period has expired. This sale was completed ${Math.floor(daysSinceSale)} day(s) ago, and the warranty window is ${WARRANTY_DAYS} days.`,
          },
          { status: 400 }
        )
      }
    }

    // 2. Restock each item and log it
    for (const item of items) {
      if (!item.itemId) continue
      const itemRef = doc(db, 'inventory', item.itemId)

      await runTransaction(db, async (txn) => {
        const itemSnap = await txn.get(itemRef)
        if (!itemSnap.exists()) return

        const itemData = itemSnap.data() as Record<string, unknown>
        const stockBefore = typeof itemData.stock === 'number' ? itemData.stock : 0
        const stockAfter = stockBefore + item.quantity

        txn.update(itemRef, { stock: stockAfter })

        await addDoc(collection(db, 'stockLogs'), {
          createdAt: serverTimestamp(),
          actionType: 'sale_refund',
          itemId: item.itemId,
          itemName: item.name,
          condition: item.condition ?? itemData.condition ?? 'New',
          quantityBefore: stockBefore,
          quantityChanged: item.quantity,
          quantityAfter: stockAfter,
          stockBefore,
          stockAfter,
          reservedBefore: typeof itemData.reservedStock === 'number' ? itemData.reservedStock : 0,
          reservedAfter: typeof itemData.reservedStock === 'number' ? itemData.reservedStock : 0,
          remarks: `Refund – ${receiptNumber}: ${reason}`,
          referenceId: receiptNumber,
          referenceType: 'refund',
        })
      })
    }

    // 3. Mark sale as refunded
    await runTransaction(db, async (txn) => {
      txn.update(saleRef, {
        status: 'refunded',
        refundedAt: serverTimestamp(),
        refundReason: reason,
      })
    })

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('Refund error:', err)
    return NextResponse.json({ error: 'Failed to process refund' }, { status: 500 })
  }
}
