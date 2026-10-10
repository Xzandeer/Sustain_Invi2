// Upcoming events the owner enters for the forecast - a delivery of new stock,
// a day the store is closed, a sale. The statistical forecast cannot know
// about them; the AI review uses them as its strongest reason to adjust a day.

import { getAdminDb } from '@/lib/firebaseAdmin'

export const FORECAST_EVENTS_COLLECTION = 'forecastEvents'
export const MAX_EVENT_NOTE = 120

export interface ForecastEvent {
  id: string
  date: string // YYYY-MM-DD
  note: string
  createdByName: string
  createdAt: string
}

export async function getForecastEvents(fromKey: string, toKey: string): Promise<ForecastEvent[]> {
  try {
    const snap = await getAdminDb()
      .collection(FORECAST_EVENTS_COLLECTION)
      .where('date', '>=', fromKey)
      .where('date', '<=', toKey)
      .get()
    return snap.docs
      .map((d) => {
        const data = d.data() as Record<string, unknown>
        return {
          id: d.id,
          date: String(data.date ?? ''),
          note: String(data.note ?? ''),
          createdByName: String(data.createdByName ?? ''),
          createdAt: String(data.createdAt ?? ''),
        }
      })
      .filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.date) && e.note)
      .sort((a, b) => a.date.localeCompare(b.date))
  } catch (error) {
    // Events are optional context. A failure must not stop the forecast.
    console.warn('[forecastEvents] Could not read events:', error)
    return []
  }
}
