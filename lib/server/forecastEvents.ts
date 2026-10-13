// Upcoming events the owner enters for the forecast - a delivery of new stock,
// a day the store is closed, a sale. The statistical forecast cannot know
// about them; the AI review uses them as its strongest reason to adjust a day.

import { getAdminDb } from '@/lib/firebaseAdmin'

export const FORECAST_EVENTS_COLLECTION = 'forecastEvents'
export const MAX_EVENT_NOTE = 120

export const EVENT_TYPES = ['shipment', 'sale', 'closure', 'other'] as const
export type EventType = (typeof EVENT_TYPES)[number]

export const toEventType = (v: unknown): EventType =>
  (EVENT_TYPES as readonly string[]).includes(String(v)) ? (v as EventType) : 'other'

export interface ForecastEvent {
  id: string
  date: string // YYYY-MM-DD
  type: EventType
  // 'auto'   = the AI decided which categories the event affects (aiCategories)
  // 'manual' = the owner chose: `category` is one category, '' = whole store
  // Events saved before either existed have neither and are matched by wording.
  categoryMode?: 'auto' | 'manual'
  category: string
  aiWholeStore?: boolean
  aiCategories?: string[]
  aiReason?: string
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
          type: toEventType(data.type),
          categoryMode:
            data.categoryMode === 'auto' || data.categoryMode === 'manual'
              ? (data.categoryMode as 'auto' | 'manual')
              : undefined,
          category: typeof data.category === 'string' ? data.category.trim() : '',
          aiWholeStore: data.aiWholeStore === true,
          aiCategories: Array.isArray(data.aiCategories) ? data.aiCategories.map(String) : [],
          aiReason: typeof data.aiReason === 'string' ? data.aiReason : '',
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

// ── Which events apply to a category forecast ──────────────────────────────
//
// Each event carries a decision about which categories it affects - made by the
// language model when the event was saved (categoryMode 'auto'), or chosen by
// the owner ('manual'). That saved decision is applied here, so every forecast
// treats the event the same way. Older events with neither are matched by their
// wording (category names, tolerating small typos) as a fallback.

const words = (text: string) => text.toLowerCase().match(/[a-z]+/g) ?? []

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  return dp[a.length][b.length]
}

/** True when `text` mentions the category name, tolerating plurals and small typos. */
export function mentionsCategory(text: string, categoryName: string): boolean {
  const target = words(categoryName).filter((w) => w.length >= 4)
  if (target.length === 0) return false
  const have = words(text)
  return target.every((t) => {
    const stem = t.replace(/(ies|es|s)$/, '')
    return have.some((w) => {
      const ws = w.replace(/(ies|es|s)$/, '')
      return ws === stem || editDistance(ws, stem) <= (stem.length >= 7 ? 2 : 1)
    })
  })
}

export function eventsForScope(
  events: ForecastEvent[],
  category: string | undefined,
  allCategoryNames: string[]
): ForecastEvent[] {
  if (!category) return events // whole-store forecast: every event applies
  const scope = category.trim().toLowerCase()
  return events.filter((e) => {
    // The AI's saved decision about which categories the event affects.
    if (e.categoryMode === 'auto') {
      return e.aiWholeStore === true ||
        (e.aiCategories ?? []).some((c) => c.trim().toLowerCase() === scope)
    }
    // The owner's own choice.
    if (e.categoryMode === 'manual') return !e.category || e.category.trim().toLowerCase() === scope
    // Older events: by wording.
    if (e.category) return e.category.trim().toLowerCase() === scope
    if (mentionsCategory(e.note, category)) return true
    const namesOther = allCategoryNames.some(
      (n) => n.trim().toLowerCase() !== scope && mentionsCategory(e.note, n)
    )
    return !namesOther
  })
}

// ── Category catalogue for the classifier ──────────────────────────────────
// Each category with its price range and a few example items, taken from the
// live inventory, so the language model can tell what "big items" or "school
// stock" refers to in this particular store.
export async function getCategoryCatalogue(): Promise<
  Array<{ name: string; priceMin: number; priceMax: number; examples: string[] }>
> {
  const db = getAdminDb()
  const [catSnap, invSnap] = await Promise.all([db.collection('categories').get(), db.collection('inventory').get()])
  const names = Array.from(new Set(
    catSnap.docs.map((d) => String((d.data() as Record<string, unknown>).name ?? '').trim()).filter(Boolean)
  ))
  const items = invSnap.docs
    .map((d) => d.data() as Record<string, unknown>)
    .filter((d) => d.isDeleted !== true && d.isVoided !== true)
  return names.map((name) => {
    const own = items
      .filter((d) => String(d.categoryName ?? d.category ?? '').trim().toLowerCase() === name.toLowerCase())
      .map((d) => ({ name: String(d.name ?? ''), price: Number(d.price) || 0 }))
      .sort((a, b) => b.price - a.price)
    const prices = own.map((i) => i.price)
    return {
      name,
      priceMin: prices.length ? Math.min(...prices) : 0,
      priceMax: prices.length ? Math.max(...prices) : 0,
      examples: own.slice(0, 4).map((i) => i.name),
    }
  })
}
