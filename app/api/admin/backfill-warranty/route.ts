// One-time maintenance endpoint.
//
// Sales created before the warranty-snapshot feature have no `warrantyDays`
// field, so their refund window silently follows whatever the current store
// policy happens to be. This stamps the current policy onto those sales so
// their window is fixed from now on.
//
// GET  → reports how many sales are missing the snapshot (no writes)
// POST → stamps them
//
// Admin-only. Safe to run more than once — it skips sales that already have it.

import { NextRequest, NextResponse } from 'next/server'
import { collection, getDocs, writeBatch, doc } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { getWarrantyDays } from '@/lib/server/storeSettings'
import { checkPermission } from '@/lib/server/authorize'

export const dynamic = 'force-dynamic'

async function findUnstamped() {
  const snap = await getDocs(collection(db, 'sales'))
  return snap.docs.filter((d) => {
    const data = d.data() as Record<string, unknown>
    return typeof data.warrantyDays !== 'number'
  })
}

export async function GET() {
  try {
    const missing = await findUnstamped()
    const currentPolicy = await getWarrantyDays()
    return NextResponse.json({
      salesMissingSnapshot: missing.length,
      currentPolicyDays: currentPolicy,
      note:
        missing.length > 0
          ? `POST to this endpoint to stamp ${missing.length} sale(s) with ${currentPolicy} days.`
          : 'All sales already have a warranty snapshot.',
    })
  } catch (err) {
    console.error('[backfill-warranty] GET error:', err)
    return NextResponse.json({ error: 'Failed to inspect sales.' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>

    // Admin-only
    const uid = typeof body.requestedByUid === 'string' ? body.requestedByUid : ''
    const authz = await checkPermission(uid, 'canManageInventory')
    if (!authz.allowed || authz.role !== 'admin') {
      return NextResponse.json(
        { error: 'Only an administrator can run this operation.' },
        { status: 403 }
      )
    }

    // Optional override, otherwise use the current store policy
    const override = Number(body.warrantyDays)
    const days =
      Number.isFinite(override) && override >= 0 && override <= 365
        ? Math.floor(override)
        : await getWarrantyDays()

    const missing = await findUnstamped()
    if (missing.length === 0) {
      return NextResponse.json({ success: true, updated: 0, warrantyDays: days })
    }

    let updated = 0
    for (let i = 0; i < missing.length; i += 400) {
      const batch = writeBatch(db)
      for (const d of missing.slice(i, i + 400)) {
        batch.update(doc(db, 'sales', d.id), { warrantyDays: days })
      }
      await batch.commit()
      updated += Math.min(400, missing.length - i)
    }

    return NextResponse.json({ success: true, updated, warrantyDays: days })
  } catch (err) {
    console.error('[backfill-warranty] POST error:', err)
    return NextResponse.json({ error: 'Backfill failed.' }, { status: 500 })
  }
}
