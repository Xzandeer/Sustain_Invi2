// aiEnhancement.ts
// AI enhancement layer for the hybrid forecasting system.
// Uses OpenAI GPT-4o-mini via native REST fetch (no SDK required).
//
// The AI receives ONLY a compact summary — never raw database records.
// Its adjustments are validated and bounded to ±15% of the weighted baseline
// to prevent hallucination or unrealistic projections.

import type { WeightedDay, WeightedForecastResult } from './weightedForecast'
import type { SalesSummary } from './salesSummary'

export interface AIForecastDay {
  day: string       // "Day 1" ... "Day 7"
  date: string      // YYYY-MM-DD
  weighted: number  // base model value (unchanged)
  ai: number        // AI-adjusted value
  delta: number     // difference: ai - weighted
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

function buildPrompt(base: WeightedForecastResult, summary: SalesSummary): string {
  const topCats = summary.topCategories
    .map(c => `${c.name}: ${c.units} units`)
    .join(', ')

  // Last 7 days of actual daily revenue for trend context
  const recentRevenue = summary.daily
    .slice(-7)
    .map(d => `${d.date}: ${Math.round(d.revenue)}`)
    .join(', ')

  return `You are a sales forecasting engine for a Philippine surplus retail store.

STATISTICAL BASE FORECAST (7 days):
${base.forecast.map(d => `${d.day} (${d.date}): ${d.weighted}`).join('\n')}

TREND CONTEXT:
- Base average daily revenue: ${base.avgDailyRevenue}
- Trend direction: ${base.trendDirection} (${base.trendPct > 0 ? '+' : ''}${base.trendPct}% week-over-week)
- Recent daily revenue (last 7 days actual): ${recentRevenue || 'insufficient data'}
- Top categories (last 14 days): ${topCats || 'no category data'}
- Week-over-week revenue change: ${summary.wowChange > 0 ? '+' : ''}${summary.wowChange}%

TASK:
Analyze the trend and slightly adjust the base forecast.
Rules:
1. Adjustments must be small and realistic (max ±15% of the base value per day)
2. Do not change all 7 days the same way — vary by trend acceleration/deceleration
3. Write a 1-sentence business insight explaining the pattern
4. Set confidence based on data quality: high = 14+ days data, medium = 7-13 days, low = 3-6 days
   Current data: ${summary.totalDaysWithData} days

IMPORTANT: Return ONLY valid JSON. No text outside JSON. No markdown. No code blocks.

Required format:
{
  "forecast": [
    { "day": "Day 1", "weighted": 0, "ai": 0 },
    { "day": "Day 2", "weighted": 0, "ai": 0 },
    { "day": "Day 3", "weighted": 0, "ai": 0 },
    { "day": "Day 4", "weighted": 0, "ai": 0 },
    { "day": "Day 5", "weighted": 0, "ai": 0 },
    { "day": "Day 6", "weighted": 0, "ai": 0 },
    { "day": "Day 7", "weighted": 0, "ai": 0 }
  ],
  "insight": "one sentence",
  "confidence": "low"
}`
}

// ── AI bounds enforcer ─────────────────────────────────────────────────────────
// Clamps each AI day to ±15% of the weighted baseline.
// Prevents GPT from hallucinating extreme values.

function clampAI(aiValue: number, weighted: number): number {
  const min = Math.round(weighted * 0.85)
  const max = Math.round(weighted * 1.15)
  return Math.max(min, Math.min(max, Math.round(aiValue)))
}

// ── OpenAI REST call ───────────────────────────────────────────────────────────

interface OAIResponse {
  choices: Array<{ message: { content: string | null } }>
  error?: { message: string }
}

async function callOpenAI(apiKey: string, prompt: string): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
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
      max_tokens: 400,
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
  forecast?: Array<{ day?: string; weighted?: number; ai?: number }>
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
    const ai = clampAI(aiRaw, weighted)
    return {
      day: base.day,
      date: base.date,
      weighted,
      ai,
      delta: ai - weighted,
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
}

async function readFromFirestore(): Promise<AIEnhancementResult | null> {
  try {
    const db = getAdminDb()
    const snap = await db.collection(CACHE_COLLECTION).doc(CACHE_DOC).get()
    if (!snap.exists) return null
    const doc = snap.data() as CacheDocument
    if (Date.now() > doc.expiresAt) return null   // expired
    return { ...doc.result, fromCache: true }
  } catch {
    return null   // Firestore unavailable — proceed without cache
  }
}

async function writeToFirestore(result: AIEnhancementResult): Promise<void> {
  try {
    const db = getAdminDb()
    const doc: CacheDocument = {
      result,
      cachedAt: Date.now(),
      expiresAt: Date.now() + CACHE_TTL_MS,
    }
    await db.collection(CACHE_COLLECTION).doc(CACHE_DOC).set(doc)
  } catch {
    // Non-fatal — cache write failure just means next request re-calls OpenAI
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function enhanceWithAI(
  base: WeightedForecastResult,
  summary: SalesSummary,
  apiKey: string,
  force = false           // true = bypass cache, always call OpenAI fresh
): Promise<AIEnhancementResult> {
  // 1. Try Firestore cache first — skip if force=true (user clicked Regenerate)
  if (!force) {
    const cached = await readFromFirestore()
    if (cached) return cached
  }

  // 2. Call OpenAI
  const prompt = buildPrompt(base, summary)
  let raw: string
  try {
    raw = await callOpenAI(apiKey, prompt)
  } catch (err) {
    return {
      forecast: base.forecast.map(d => ({ ...d, ai: d.weighted, delta: 0 })),
      insight: 'AI enhancement temporarily unavailable — showing statistical forecast.',
      confidence: 'low',
      error: err instanceof Error ? err.message : 'OpenAI call failed',
    }
  }

  // 3. Parse and validate (clamps values to ±15%)
  let result: AIEnhancementResult
  try {
    result = parseAndValidate(raw, base.forecast)
  } catch (err) {
    return {
      forecast: base.forecast.map(d => ({ ...d, ai: d.weighted, delta: 0 })),
      insight: 'AI response parsing failed — showing statistical forecast.',
      confidence: 'low',
      error: err instanceof Error ? err.message : 'Parse error',
    }
  }

  // 4. Persist to Firestore (non-blocking)
  if (!result.error) {
    writeToFirestore(result).catch(() => {})
  }

  return result
}
