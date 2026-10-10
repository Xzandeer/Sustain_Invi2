// weightedForecast.ts
// Statistical base model — exponential weighted moving average.
// This runs entirely locally (no AI, no API calls) and is the
// foundation that the AI enhancement layer builds on top of.

import type { DailyStat } from './salesSummary'

export interface WeightedDay {
  day: string       // "Day 1", "Day 2", ...
  date: string      // YYYY-MM-DD (projected date)
  weighted: number  // rounded revenue forecast
}

export interface WeightedForecastResult {
  forecast: WeightedDay[]
  avgDailyRevenue: number   // base daily average from recent data
  trendFactor: number       // 1.0 = flat, >1 = growing, <1 = declining
  trendPct: number          // e.g. +12.5 or -3.2
  trendDirection: 'increasing' | 'decreasing' | 'stable'
  dataPoints: number        // how many days were used
}

/**
 * Produces a 7-day weighted forecast from daily sales stats.
 *
 * Algorithm:
 *  1. Apply exponential decay weights to the last N days (more recent = higher weight)
 *  2. Compute weighted average daily revenue
 *  3. Report the week-over-week trend (last 7 vs prior 7 days) for display only
 *  4. Project 7 days forward at the weighted level (flat - no trend multiplier)
 *
 * Why the forecast is flat: a rolling backtest on the shop's 2026 daily sales
 * (see SUSTAIN_Forecast_Validation) showed that extending the recent trend
 * forward made the forecast worse, not better. Japan-surplus sales jump when a
 * container arrives and fall back afterwards, so a busy week does not predict
 * a busier one. On held-out data (May-Aug) removing the trend raised weekly
 * accuracy from 59.5% to 63.7% and cut the bias from +5.6% to -0.1%.
 */
export function buildWeightedForecast(daily: DailyStat[]): WeightedForecastResult {
  // Use up to last 14 days for the weighted average
  const recent = daily.slice(-14)
  const n = recent.length

  // Exponential decay weights: w[i] = exp(lambda * i), normalised
  // lambda = 0.15 gives ~3x more weight to today vs 14 days ago
  const lambda = 0.15
  const rawWeights = recent.map((_, i) => Math.exp(lambda * i))
  const weightSum = rawWeights.reduce((a, b) => a + b, 0)
  const weights = rawWeights.map(w => w / weightSum)

  const avgDailyRevenue = recent.reduce((sum, d, i) => sum + d.revenue * weights[i], 0)

  // Trend: last 7 days vs prior 7 days average
  const last7 = recent.slice(-7)
  const prior7 = recent.slice(-14, -7)

  const avg7 = last7.length > 0
    ? last7.reduce((s, d) => s + d.revenue, 0) / last7.length
    : avgDailyRevenue

  const avgPrior7 = prior7.length > 0
    ? prior7.reduce((s, d) => s + d.revenue, 0) / prior7.length
    : avg7

  // Week-over-week change, shown to the user as context ("sales are up 12%
  // on last week"). It is NOT applied to the projection - see the note above.
  const rawTrend = avgPrior7 > 0 ? avg7 / avgPrior7 : 1.0
  const trendFactor = rawTrend
  const trendPct = parseFloat(((rawTrend - 1) * 100).toFixed(1))
  const trendDirection: 'increasing' | 'decreasing' | 'stable' =
    trendPct > 2 ? 'increasing' : trendPct < -2 ? 'decreasing' : 'stable'

  // Project 7 days forward. Every day carries the same weighted level: the
  // validated method, and the honest one - the model has no information that
  // tells one future day apart from another.
  const level = Math.max(0, Math.round(avgDailyRevenue))
  const today = new Date()
  const forecast: WeightedDay[] = Array.from({ length: 7 }, (_, i) => {
    // Calendar dates in the Philippines, so they line up with holidays and
    // owner-entered events regardless of the server's timezone.
    const projDate = new Date(today.getTime() + (i + 1) * 86400000)
    const dateStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(projDate)

    return {
      day: `Day ${i + 1}`,
      date: dateStr,
      weighted: level,
    }
  })

  return {
    forecast,
    avgDailyRevenue: Math.round(avgDailyRevenue),
    trendFactor: parseFloat(trendFactor.toFixed(4)),
    trendPct,
    trendDirection,
    dataPoints: n,
  }
}
