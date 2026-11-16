// Units of one inventory item - one record per physical piece.
//
// GET /api/inventory/[id]/units           every unit of the item, newest first
// GET /api/inventory/[id]/units?status=in_stock
//
// Used by the Units panel on the Inventory page. The Admin SDK bypasses the
// database rules, so the caller is checked here.

import { NextResponse, type NextRequest } from 'next/server'
import { requireActiveUserRequest } from '@/lib/server/authorize'
import { getAdminDb } from '@/lib/firebaseAdmin'
import { UNITS_COLLECTION, type UnitStatus } from '@/lib/inventory/units'

interface RouteContext {
  params: Promise<{ id: string }>
}

const STATUSES: UnitStatus[] = ['in_stock', 'reserved', 'sold', 'written_off']

export async function GET(req: NextRequest, context: RouteContext) {
  const denied = await requireActiveUserRequest(req)
  if (denied) return denied

  try {
    const { id } = await context.params
    const status = new URL(req.url).searchParams.get('status') as UnitStatus | null
    let query = getAdminDb().collection(UNITS_COLLECTION).where('itemId', '==', id)
    if (status && STATUSES.includes(status)) query = query.where('status', '==', status)

    const snap = await query.get()
    const units = snap.docs
      .map((d) => {
        const data = d.data() as Record<string, unknown>
        return {
          id: d.id,
          unitCode: typeof data.unitCode === 'string' ? data.unitCode : '',
          grade: typeof data.grade === 'string' ? data.grade : 'Good',
          conditionNotes: typeof data.conditionNotes === 'string' ? data.conditionNotes : '',
          priceOverride: typeof data.priceOverride === 'number' ? data.priceOverride : null,
          status: typeof data.status === 'string' ? data.status : 'in_stock',
          receivedAt: typeof data.receivedAt === 'string' ? data.receivedAt : '',
          soldAt: typeof data.soldAt === 'string' ? data.soldAt : null,
          reservationId: typeof data.reservationId === 'string' ? data.reservationId : null,
          saleId: typeof data.saleId === 'string' ? data.saleId : null,
        }
      })
      // Pieces on the shelf first, oldest arrival first - the order they sell in.
      .sort((a, b) =>
        STATUSES.indexOf(a.status as UnitStatus) - STATUSES.indexOf(b.status as UnitStatus) ||
        a.receivedAt.localeCompare(b.receivedAt) ||
        a.unitCode.localeCompare(b.unitCode))

    return NextResponse.json({ data: units })
  } catch (error) {
    console.error('GET /api/inventory/[id]/units error:', error)
    return NextResponse.json({ error: 'Could not load units.' }, { status: 500 })
  }
}
