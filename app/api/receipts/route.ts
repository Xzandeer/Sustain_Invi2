// Receipt lookup.
//
// GET ?status=active&limit=1 → most recent receipts, newest first.
// Used to pull the last receipt back up for reprinting or emailing.
//
// Requires a Firestore composite index on (status, createdAt desc). If this
// returns a 500 mentioning an index, the error message contains a link that
// creates it.

import { NextRequest, NextResponse } from 'next/server'
import { collection, getDocs, query, where, orderBy, limit } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { ReceiptRecord } from '@/lib/transactions/transactionDocuments'

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const status = searchParams.get('status') ?? 'active'
    const limitCount = Number(searchParams.get('limit') ?? 1)

    let receiptsQuery = query(
      collection(db, 'receipts'),
      where('status', '==', status),
      orderBy('createdAt', 'desc'),
      limit(Number.isFinite(limitCount) && limitCount > 0 ? limitCount : 1)
    )

    const snapshot = await getDocs(receiptsQuery)
    const data: ReceiptRecord[] = snapshot.docs
      .map((docEntry) => ({ id: docEntry.id, ...(docEntry.data() as Omit<ReceiptRecord, 'id'>) }))

    return NextResponse.json({ data }, { status: 200 })
  } catch (error) {
    console.error('GET /api/receipts error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
