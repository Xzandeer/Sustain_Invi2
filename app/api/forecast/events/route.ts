// Upcoming events for the forecast (see lib/server/forecastEvents.ts).
//
// GET              → events from today onward (next 30 days)
// POST {date,note} → add an event
// DELETE ?id=...   → remove an event
//
// Same permission as the forecast itself: View Analytics.

import { NextRequest, NextResponse } from 'next/server'
import { getAdminDb } from '@/lib/firebaseAdmin'
import { guardRequest, verifiedUid } from '@/lib/server/authorize'
import {
  FORECAST_EVENTS_COLLECTION,
  MAX_EVENT_NOTE,
  getForecastEvents,
} from '@/lib/server/forecastEvents'

export const dynamic = 'force-dynamic'

const MAX_DAYS_AHEAD = 30

// Today's date in the Philippines, offset by `days`.
function manilaKey(days = 0): string {
  const d = new Date(Date.now() + days * 86400000)
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d)
}

async function guard(req: NextRequest): Promise<NextResponse | null> {
  try {
    return await guardRequest(req, 'canViewAnalytics')
  } catch (error) {
    console.error('[forecast/events] Authorization check failed:', error)
    return NextResponse.json({ error: 'The server could not verify your account.' }, { status: 500 })
  }
}

export async function GET(req: NextRequest) {
  const denied = await guard(req)
  if (denied) return denied
  const events = await getForecastEvents(manilaKey(0), manilaKey(MAX_DAYS_AHEAD))
  return NextResponse.json({ events })
}

export async function POST(req: NextRequest) {
  const denied = await guard(req)
  if (denied) return denied

  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const date = typeof body.date === 'string' ? body.date.trim() : ''
    const note = typeof body.note === 'string' ? body.note.trim().replace(/\s+/g, ' ') : ''

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: 'Choose a date for the event.' }, { status: 400 })
    }
    if (date < manilaKey(0) || date > manilaKey(MAX_DAYS_AHEAD)) {
      return NextResponse.json(
        { error: `The date must be between today and ${MAX_DAYS_AHEAD} days from now.` },
        { status: 400 }
      )
    }
    if (!note) {
      return NextResponse.json({ error: 'Describe the event, e.g. "New shipment arriving".' }, { status: 400 })
    }
    if (note.length > MAX_EVENT_NOTE) {
      return NextResponse.json({ error: `Keep the description under ${MAX_EVENT_NOTE} characters.` }, { status: 400 })
    }

    const uid = await verifiedUid(req)
    const userSnap = uid ? await getAdminDb().collection('users').doc(uid).get() : null
    const userData = (userSnap?.data() ?? {}) as Record<string, unknown>
    const createdByName =
      (typeof userData.name === 'string' && userData.name) ||
      (typeof userData.email === 'string' && userData.email) ||
      'Unknown'

    const ref = await getAdminDb().collection(FORECAST_EVENTS_COLLECTION).add({
      date,
      note,
      createdByUid: uid ?? '',
      createdByName,
      createdAt: new Date().toISOString(),
    })
    return NextResponse.json({ id: ref.id, date, note, createdByName })
  } catch (error) {
    console.error('[forecast/events] POST failed:', error)
    return NextResponse.json({ error: 'Could not save the event.' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  const denied = await guard(req)
  if (denied) return denied

  try {
    const id = new URL(req.url).searchParams.get('id')?.trim()
    if (!id) return NextResponse.json({ error: 'Missing event id.' }, { status: 400 })
    await getAdminDb().collection(FORECAST_EVENTS_COLLECTION).doc(id).delete()
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('[forecast/events] DELETE failed:', error)
    return NextResponse.json({ error: 'Could not remove the event.' }, { status: 500 })
  }
}
