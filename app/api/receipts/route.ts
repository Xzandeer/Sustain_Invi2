import { NextRequest, NextResponse } from 'next/server'
import { collection, getDocs, query, where, orderBy, limit } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { ReceiptRecord } from '@/lib/transactionDocuments'

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
      .map((docEntry) => ({ id: docEntry.id, ...(docEntry.data() as ReceiptRecord) }))

    return NextResponse.json({ data }, { status: 200 })
  } catch (error) {
    console.error('GET /api/receipts error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
