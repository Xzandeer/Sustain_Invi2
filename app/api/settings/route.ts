// Store settings API — GET current settings, PUT to update them.
// Backed by Firestore document: storeSettings/general

import { NextRequest, NextResponse } from 'next/server'
import { doc, setDoc, serverTimestamp } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { getStoreSettings } from '@/lib/server/storeSettings'
import { SETTINGS_COLLECTION, SETTINGS_DOC } from '@/lib/constants/warranty'

export const dynamic = 'force-dynamic'

export async function GET() {
  const settings = await getStoreSettings()
  return NextResponse.json(settings)
}

export async function PUT(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>

    const raw = body.warrantyDays
    const parsed =
      typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN

    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 365) {
      return NextResponse.json(
        { error: 'Warranty period must be a whole number between 0 and 365 days.' },
        { status: 400 }
      )
    }

    const warrantyDays = Math.floor(parsed)
    const updatedBy =
      typeof body.updatedByEmail === 'string' ? body.updatedByEmail.trim() : ''

    await setDoc(
      doc(db, SETTINGS_COLLECTION, SETTINGS_DOC),
      { warrantyDays, updatedAt: serverTimestamp(), updatedBy },
      { merge: true }
    )

    return NextResponse.json({ success: true, warrantyDays })
  } catch (err) {
    console.error('[settings] Error:', err)
    return NextResponse.json({ error: 'Failed to save settings.' }, { status: 500 })
  }
}
