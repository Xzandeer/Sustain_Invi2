// app/api/forecast/ai-enhanced/route.ts
// Hybrid AI Prediction System — GET endpoint
//
// Pipeline:
//  1. Fetch summarized Firestore sales data (last 28 days)
//  2. Run statistical weighted forecast (base model)
//  3. Enhance with GPT-4o-mini (AI layer, bounded to ±15%) - optional
//  4. Return combined response for dashboard chart rendering
//
// The statistical forecast is the validated method and is always returned.
// Without an OPENAI_API_KEY the route still answers, just without aiForecast,
// so the chart shows the same numbers the validation tested.
//
// Response shape:
// {
//   success: true,
//   canForecast: true,
//   baseForecast: WeightedForecastResult,
//   aiForecast:   AIEnhancementResult | null   (null when no API key)
//   summary: { wowChange, trendDirection, topCategories, totalDaysWithData },
//   generatedAt: ISO string,
//   fromCache: boolean
// }

import { NextResponse, type NextRequest } from 'next/server'
import { guardRequest } from '@/lib/server/authorize'
import { getSalesSummary } from '@/lib/ai/forecast/salesSummary'
import { buildWeightedForecast } from '@/lib/ai/forecast/weightedForecast'
import { enhanceWithAI } from '@/lib/ai/forecast/aiEnhancement'

export const dynamic = 'force-dynamic'
// Room for the database reads plus the language-model call. The model call has
// its own shorter timeout (aiEnhancement.ts), so this is only a ceiling.
export const maxDuration = 30

export async function GET(req: NextRequest) {
  // Inside a try: if the server cannot even check the caller (for example the
  // Firebase admin credentials are missing on the host), the browser must still
  // get a JSON error it can show, not an HTML error page.
  try {
    const denied = await guardRequest(req, 'canViewAnalytics')
    if (denied) return denied
  } catch (error) {
    console.error('[forecast/ai-enhanced] Authorization check failed:', error)
    return NextResponse.json(
      {
        success: false,
        error: 'The server could not verify your account. Check the Firebase admin settings on the host.',
      },
      { status: 500 }
    )
  }

  // ?force=true bypasses Firestore cache and always calls OpenAI fresh
  // ?category=Footwear scopes the forecast to a single category
  const url = new URL(req.url)
  const force = url.searchParams.get('force') === 'true'
  const categoryParam = url.searchParams.get('category')?.trim() || undefined
  const category = categoryParam && categoryParam.toLowerCase() !== 'all' ? categoryParam : undefined

  try {
    // ── 2. Fetch summarized sales data ────────────────────────────────────────
    const summary = await getSalesSummary(category)

    if (!summary.canForecast) {
      return NextResponse.json({
        success: true,
        canForecast: false,
        reason: summary.reason,
        totalDaysWithData: summary.totalDaysWithData,
        message: 'Not enough sales data to generate a forecast yet.',
      })
    }

    // ── 3. Statistical base forecast ──────────────────────────────────────────
    const baseForecast = buildWeightedForecast(summary.daily)

    // ── 4. AI enhancement layer (optional) ────────────────────────────────────
    const apiKey = process.env.OPENAI_API_KEY
    const aiForecast = apiKey
      ? await enhanceWithAI(baseForecast, summary, apiKey, force, category)
      : null

    // ── 5. Return combined result ─────────────────────────────────────────────
    return NextResponse.json({
      success: true,
      canForecast: true,
      category: category ?? 'all',
      baseForecast: {
        forecast: baseForecast.forecast,
        avgDailyRevenue: baseForecast.avgDailyRevenue,
        trendFactor: baseForecast.trendFactor,
        trendPct: baseForecast.trendPct,
        trendDirection: baseForecast.trendDirection,
        dataPoints: baseForecast.dataPoints,
      },
      aiForecast: aiForecast
        ? {
            forecast: aiForecast.forecast,
            insight: aiForecast.insight,
            confidence: aiForecast.confidence,
            fromCache: aiForecast.fromCache ?? false,
            ...(aiForecast.error ? { warning: aiForecast.error } : {}),
          }
        : null,
      summary: {
        wowChange: summary.wowChange,
        last7Revenue: summary.last7Revenue,
        prior7Revenue: summary.prior7Revenue,
        topCategories: summary.topCategories,
        totalDaysWithData: summary.totalDaysWithData,
        dataStart: summary.dataStart,
        dataEnd: summary.dataEnd,
      },
      generatedAt: new Date().toISOString(),
    })

  } catch (error) {
    console.error('[forecast/ai-enhanced] Error:', error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unexpected server error',
      },
      { status: 500 }
    )
  }
}
