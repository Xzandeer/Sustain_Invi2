// Upcoming events for the forecast (see lib/server/forecastEvents.ts).
//
// GET              → events from today onward (next 30 days)
// POST {date,type,category,note} → add an event
//      type: shipment | sale | closure | other
//      category: 'auto' (default, the AI decides), '' = whole store, or a category name
// DELETE ?id=...   → remove an event
//
// Same permission as the forecast itself: View Analytics.

import { NextRequest, NextResponse } from 'next/server'
import { getAdminDb } from '@/lib/firebaseAdmin'
import { guardRequest, verifiedUid } from '@/lib/server/authorize'
import {
  FORECAST_EVENTS_COLLECTION,
  MAX_EVENT_NOTE,
  getCategoryCatalogue,
  getForecastEvents,
  toEventType,
} from '@/lib/server/forecastEvents'
import { classifyEvent } from '@/lib/ai/forecast/eventClassifier'

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
    // The owner only writes the description. The AI works out the event type
    // and the categories it affects; both can still be passed explicitly.
    let type = body.type ? toEventType(body.type) : 'other'
    // 'auto' (default): the AI decides which categories the event affects.
    // Otherwise the owner's choice: a category name, or '' for the whole store.
    const rawCategory = typeof body.category === 'string' ? body.category.trim().slice(0, 60) : 'auto'
    const categoryMode: 'auto' | 'manual' = rawCategory === 'auto' ? 'auto' : 'manual'
    const category = categoryMode === 'manual' ? rawCategory : ''

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

    let aiWholeStore = categoryMode === 'auto'
    let aiCategories: string[] = []
    let aiReason = ''
    if (categoryMode === 'auto') {
      const apiKey = process.env.OPENAI_API_KEY
      if (apiKey) {
        try {
          const result = await classifyEvent(note, await getCategoryCatalogue(), apiKey)
          if (!body.type) type = result.type
          aiWholeStore = result.wholeStore
          aiCategories = result.categories
          aiReason = result.reason
        } catch (error) {
          console.warn('[forecast/events] Classification failed:', error)
          aiReason = 'AI could not classify this event, so it applies to the whole store.'
        }
      } else {
        aiReason = 'AI not configured, so the event applies to the whole store.'
      }
    }

    const ref = await getAdminDb().collection(FORECAST_EVENTS_COLLECTION).add({
      date,
      type,
      categoryMode,
      category,
      aiWholeStore,
      aiCategories,
      aiReason,
      note,
      createdByUid: uid ?? '',
      createdByName,
      createdAt: new Date().toISOString(),
    })
    return NextResponse.json({
      id: ref.id, date, type, categoryMode, category, aiWholeStore, aiCategories, aiReason, note, createdByName,
    })
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
