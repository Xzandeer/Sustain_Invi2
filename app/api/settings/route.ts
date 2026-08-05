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

    // Seller details printed on the sales invoice. Required on a registered
    // invoice under RR 7-2024, so they are stored here and entered once by the
    // owner rather than hardcoded.
    const text = (value: unknown, max: number) =>
      typeof value === 'string' ? value.trim().slice(0, max) : ''

    const sellerRegisteredName = text(body.sellerRegisteredName, 120)
    const sellerAddress = text(body.sellerAddress, 200)
    const sellerTin = text(body.sellerTin, 20)

    // TIN format is 9 or 12 digits, usually written 000-000-000-000. Punctuation
    // is allowed through; only the digit count is checked, and only when a value
    // was supplied - the field is optional until the shop registers.
    const tinDigits = sellerTin.replace(/\D/g, '')
    if (sellerTin && tinDigits.length !== 9 && tinDigits.length !== 12) {
      return NextResponse.json(
        { error: 'TIN must contain 9 or 12 digits, for example 000-000-000-000.' },
        { status: 400 }
      )
    }

    await setDoc(
      doc(db, SETTINGS_COLLECTION, SETTINGS_DOC),
      {
        warrantyDays,
        sellerRegisteredName,
        sellerAddress,
        sellerTin,
        updatedAt: serverTimestamp(),
        updatedBy,
      },
      { merge: true }
    )

    return NextResponse.json({
      success: true,
      warrantyDays,
      sellerRegisteredName,
      sellerAddress,
      sellerTin,
    })
  } catch (err) {
    console.error('[settings] Error:', err)
    return NextResponse.json({ error: 'Failed to save settings.' }, { status: 500 })
  }
}
