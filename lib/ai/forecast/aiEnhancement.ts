// aiEnhancement.ts
// AI enhancement layer for the hybrid forecasting system.
// Uses OpenAI GPT-4o-mini via native REST fetch (no SDK required).
//
// The AI receives ONLY a compact summary — never raw database records.
// Its adjustments are validated and bounded to ±15% of the weighted baseline
// to prevent hallucination or unrealistic projections.

import type { WeightedDay, WeightedForecastResult } from './weightedForecast'
import type { SalesSummary } from './salesSummary'
import { describeDay } from './calendar'

/** An owner-entered event on a forecast day (lib/server/forecastEvents.ts). */
export interface ForecastEventInput {
  date: string
  note: string
}

export interface AIForecastDay {
  day: string       // "Day 1" ... "Day 7"
  date: string      // YYYY-MM-DD
  weighted: number  // base model value (unchanged)
  ai: number        // AI-adjusted value
  delta: number     // difference: ai - weighted
  // Why the AI changed this day or left it alone, in one short phrase.
  reason?: string
  // adjusted = change accepted; kept = AI chose no change;
  // rejected = AI suggested more than the 15% limit, so the calculated value stands.
  status?: 'adjusted' | 'kept' | 'rejected'
}

export interface AIEnhancementResult {
  forecast: AIForecastDay[]
  insight: string
  confidence: 'low' | 'medium' | 'high'
  fromCache?: boolean
  error?: string
}

// ── Prompt builder ─────────────────────────────────────────────────────────────
// Compact prompt: gives GPT only what it needs, minimizing token usage.

function buildPrompt(
  base: WeightedForecastResult,
  summary: SalesSummary,
  category?: string,
  events: ForecastEventInput[] = []
): string {
  const topCats = summary.topCategories
    .map(c => `${c.name}: ${c.units} units`)
    .join(', ')

  // Last 7 days of actual daily revenue for trend context
  const recentRevenue = summary.daily
    .slice(-7)
    .map(d => `${d.date}: ${Math.round(d.revenue)}`)
    .join(', ')

  return `You are a sales forecasting engine for a Philippine surplus retail store.
${category ? `\nSCOPE: This forecast covers ONLY the "${category}" category. All figures below are ${category} revenue only.\n` : ''}

STATISTICAL BASE FORECAST (7 days), with what is known about each day:
${base.forecast.map(d => {
  const c = describeDay(d.date)
  const dayEvents = events.filter(e => e.date === d.date).map(e => `OWNER EVENT: ${e.note}`)
  const facts = [
    c.weekday,
    c.holiday ? `HOLIDAY: ${c.holiday}` : null,
    c.payday ? 'payday' : null,
    ...dayEvents,
  ].filter(Boolean).join('; ')
  return `${d.day} (${d.date}, ${facts}): ${d.weighted}`
}).join('\n')}

TREND CONTEXT:
- Base average daily revenue: ${base.avgDailyRevenue}
- Trend direction: ${base.trendDirection} (${base.trendPct > 0 ? '+' : ''}${base.trendPct}% week-over-week)
- Recent daily revenue (last 7 days actual): ${recentRevenue || 'insufficient data'}
- Top categories (last 14 days): ${topCats || 'no category data'}
- Week-over-week revenue change: ${summary.wowChange > 0 ? '+' : ''}${summary.wowChange}%

TASK:
Review each day of the base forecast and decide whether to adjust it.
Rules:
1. Adjustments must be small and realistic: at most 15% above or below the base value.
   Anything beyond that is rejected by the system and the base value is used.
2. OWNER EVENTS are the strongest reason to adjust. A delivery of new stock or a sale
   usually raises sales that day and the next; a closure or bad weather lowers them.
3. Holidays are a moderate reason: shoppers may visit more or the store may be quieter,
   depending on the holiday. Paydays showed no clear effect in this store's past sales,
   so treat them as weak context only.
4. Do NOT extend the week-over-week trend into the coming days. Testing on this store's
   real sales showed that carrying a recent rise or fall forward makes the forecast less
   accurate. If there is no clear reason to adjust a day, keep the base value exactly.
5. For EVERY day give a short reason (max 12 words) for your decision, naming the
   event, holiday or pattern you used, or saying plainly that there was no reason to change.
6. Write a 1-sentence business insight for the owner about the coming week.
7. Set confidence based on data quality: high = 14+ days data, medium = 7-13 days, low = 3-6 days
   Current data: ${summary.totalDaysWithData} days

IMPORTANT: Return ONLY valid JSON. No text outside JSON. No markdown. No code blocks.

Required format:
{
  "forecast": [
    { "day": "Day 1", "weighted": 0, "ai": 0, "reason": "short reason" },
    { "day": "Day 2", "weighted": 0, "ai": 0, "reason": "short reason" },
    { "day": "Day 3", "weighted": 0, "ai": 0, "reason": "short reason" },
    { "day": "Day 4", "weighted": 0, "ai": 0, "reason": "short reason" },
    { "day": "Day 5", "weighted": 0, "ai": 0, "reason": "short reason" },
    { "day": "Day 6", "weighted": 0, "ai": 0, "reason": "short reason" },
    { "day": "Day 7", "weighted": 0, "ai": 0, "reason": "short reason" }
  ],
  "insight": "one sentence",
  "confidence": "low"
}`
}

// ── AI bounds enforcer ─────────────────────────────────────────────────────────
// The statistical forecast is the forecast. The language model may only suggest
// a small adjustment to each day: a suggestion within ±15% of the statistical
// figure is accepted; anything outside that range is rejected and the
// statistical figure is kept unchanged (it is not trimmed to the limit).

const AI_LIMIT = 0.15

function boundAI(aiValue: number, weighted: number): number {
  const suggested = Math.round(aiValue)
  const allowed = Math.abs(weighted) * AI_LIMIT
  return Math.abs(suggested - weighted) <= allowed ? suggested : weighted
}

// ── OpenAI REST call ───────────────────────────────────────────────────────────

interface OAIResponse {
  choices: Array<{ message: { content: string | null } }>
  error?: { message: string }
}

// The statistical forecast is always available, so a slow language model must
// never hold the page up: after this long the call is abandoned and the
// statistical figures are shown on their own.
const OPENAI_TIMEOUT_MS = 12_000

async function callOpenAI(apiKey: string, prompt: string): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are a strict JSON-only forecasting engine. Output only valid JSON. Never include any text, explanation, or markdown outside the JSON object.',
        },
        { role: 'user', content: prompt },
      ],
      max_tokens: 800,
      temperature: 0.2,   // low temperature = consistent, conservative adjustments
    }),
  })

  const data = (await res.json()) as OAIResponse
  if (!res.ok) {
    throw new Error(data?.error?.message ?? `OpenAI error ${res.status}`)
  }
  return data.choices[0].message.content ?? '{}'
}

// ── AI response parser ─────────────────────────────────────────────────────────

interface RawAIForecast {
  forecast?: Array<{ day?: string; weighted?: number; ai?: number; reason?: string }>
  insight?: string
  confidence?: string
}

function parseAndValidate(
  raw: string,
  baseForecast: WeightedDay[]
): AIEnhancementResult {
  // Strip any accidental markdown code fences
  const cleaned = raw.replace(/```(?:json)?/g, '').trim()

  let parsed: RawAIForecast
  try {
    parsed = JSON.parse(cleaned) as RawAIForecast
  } catch {
    throw new Error('AI returned invalid JSON: ' + raw.slice(0, 100))
  }

  if (!Array.isArray(parsed.forecast) || parsed.forecast.length !== 7) {
    throw new Error('AI forecast array missing or wrong length')
  }

  const forecast: AIForecastDay[] = parsed.forecast.map((item, i) => {
    const base = baseForecast[i]
    const weighted = base.weighted
    const aiRaw = typeof item.ai === 'number' && isFinite(item.ai) ? item.ai : weighted
    const ai = boundAI(aiRaw, weighted)
    const suggestedChange = Math.round(aiRaw) !== weighted
    const status: AIForecastDay['status'] =
      ai !== weighted ? 'adjusted' : suggestedChange ? 'rejected' : 'kept'
    const aiReason = typeof item.reason === 'string' ? item.reason.trim().slice(0, 120) : ''
    const reason =
      status === 'rejected'
        ? `Suggested change exceeded the 15% limit, so the calculated figure is kept.${aiReason ? ` (AI: ${aiReason})` : ''}`
        : aiReason || (status === 'kept' ? 'No clear reason to change this day.' : 'Adjusted by the AI.')
    return {
      day: base.day,
      date: base.date,
      weighted,
      ai,
      delta: ai - weighted,
      reason,
      status,
    }
  })

  const confidence = ['low', 'medium', 'high'].includes(String(parsed.confidence))
    ? (parsed.confidence as 'low' | 'medium' | 'high')
    : 'medium'

  const insight = typeof parsed.insight === 'string' && parsed.insight.trim()
    ? parsed.insight.trim().slice(0, 200)   // hard cap at 200 chars
    : 'Sales trend analyzed based on recent store performance.'

  return { forecast, insight, confidence }
}

// ── Firestore persistent cache (24-hour TTL) ──────────────────────────────────
// Survives Vercel cold starts. Max 1 OpenAI call per day = ~$0.0002/day.
// Stored in: ai_forecast_cache / forecast_7day (single document, overwritten)

import { getAdminDb } from '@/lib/firebaseAdmin'

const CACHE_DOC = 'forecast_7day'
const CACHE_COLLECTION = 'ai_forecast_cache'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

interface CacheDocument {
  result: AIEnhancementResult
  cachedAt: number     // Unix ms
  expiresAt: number    // Unix ms
  // The statistical forecast the AI result was built on. A cached result is
  // only reused while the current baseline is the same: if sales have changed
  // since (new sales, imported history, deleted seed data) the old AI line
  // would sit against a different baseline and break the ±15% rule.
  baseKey?: string
}

// The baseline and the owner's events together decide the AI's answer, so a
// change to either makes the cached answer stale.
const baseKeyOf = (base: WeightedForecastResult, events: ForecastEventInput[] = []) =>
  base.forecast.map(d => Math.round(d.weighted)).join(',') +
  '|' + events.map(e => `${e.date}:${e.note}`).sort().join(';')

// Cache key varies per category so category forecasts don't collide
const cacheDocId = (category?: string) =>
  category ? `${CACHE_DOC}_${category.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_')}` : CACHE_DOC

async function readFromFirestore(
  base: WeightedForecastResult,
  category?: string,
  events: ForecastEventInput[] = []
): Promise<AIEnhancementResult | null> {
  try {
    const db = getAdminDb()
    const snap = await db.collection(CACHE_COLLECTION).doc(cacheDocId(category)).get()
    if (!snap.exists) return null
    const doc = snap.data() as CacheDocument
    if (Date.now() > doc.expiresAt) return null   // expired
    if (doc.baseKey !== baseKeyOf(base, events)) return null // sales or events changed
    return { ...doc.result, fromCache: true }
  } catch {
    return null   // Firestore unavailable — proceed without cache
  }
}

async function writeToFirestore(
  result: AIEnhancementResult,
  base: WeightedForecastResult,
  category?: string,
  events: ForecastEventInput[] = []
): Promise<void> {
  try {
    const db = getAdminDb()
    const doc: CacheDocument = {
      result,
      cachedAt: Date.now(),
      expiresAt: Date.now() + CACHE_TTL_MS,
      baseKey: baseKeyOf(base, events),
    }
    await db.collection(CACHE_COLLECTION).doc(cacheDocId(category)).set(doc)
  } catch {
    // Non-fatal — cache write failure just means next request re-calls OpenAI
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function enhanceWithAI(
  base: WeightedForecastResult,
  summary: SalesSummary,
  apiKey: string,
  force = false,          // true = bypass cache, always call OpenAI fresh
  category?: string,      // optional: forecast scoped to a specific category
  events: ForecastEventInput[] = [] // owner-entered events on the forecast days
): Promise<AIEnhancementResult> {
  // 1. Try Firestore cache first — skip if force=true (user clicked Regenerate)
  if (!force) {
    const cached = await readFromFirestore(base, category, events)
    if (cached) return cached
  }

  // 2. Call OpenAI
  const prompt = buildPrompt(base, summary, category, events)
  let raw: string
  try {
    raw = await callOpenAI(apiKey, prompt)
  } catch (err) {
    return {
      forecast: base.forecast.map(d => ({
        ...d, ai: d.weighted, delta: 0, status: 'kept' as const,
        reason: 'AI unavailable; calculated figure shown.',
      })),
      insight: 'AI enhancement temporarily unavailable — showing statistical forecast.',
      confidence: 'low',
      error: err instanceof Error ? err.message : 'OpenAI call failed',
    }
  }

  // 3. Parse and validate (rejects any day outside ±15% of the statistical figure)
  let result: AIEnhancementResult
  try {
    result = parseAndValidate(raw, base.forecast)
  } catch (err) {
    return {
      forecast: base.forecast.map(d => ({
        ...d, ai: d.weighted, delta: 0, status: 'kept' as const,
        reason: 'AI response unreadable; calculated figure shown.',
      })),
      insight: 'AI response parsing failed — showing statistical forecast.',
      confidence: 'low',
      error: err instanceof Error ? err.message : 'Parse error',
    }
  }

  // 4. Persist to Firestore (non-blocking)
  if (!result.error) {
    writeToFirestore(result, base, category, events).catch(() => {})
  }

  return result
}
