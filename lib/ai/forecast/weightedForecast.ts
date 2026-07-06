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
 *  3. Detect trend by comparing last 7 days vs prior 7 days
 *  4. Project 7 days forward, incorporating the trend factor
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

  // Dampen the trend factor so projections stay conservative
  // Raw trend: avg7 / avgPrior7, then blend with 1.0 (60% trend, 40% neutral)
  const rawTrend = avgPrior7 > 0 ? avg7 / avgPrior7 : 1.0
  const trendFactor = 0.6 * rawTrend + 0.4 * 1.0
  const trendPct = parseFloat(((trendFactor - 1) * 100).toFixed(1))
  const trendDirection: 'increasing' | 'decreasing' | 'stable' =
    trendPct > 2 ? 'increasing' : trendPct < -2 ? 'decreasing' : 'stable'

  // Project 7 days forward
  // Each day applies the trend factor raised to its offset (compound trend)
  const today = new Date()
  const forecast: WeightedDay[] = Array.from({ length: 7 }, (_, i) => {
    const projDate = new Date(today)
    projDate.setDate(projDate.getDate() + i + 1)
    const dateStr = projDate.toISOString().split('T')[0]

    // Compound trend: slight acceleration/deceleration over the 7 days
    // Use a mild exponent (0.5 damping) to prevent runaway projections
    const dayMultiplier = Math.pow(trendFactor, (i + 1) * 0.5)
    const projected = Math.round(avgDailyRevenue * dayMultiplier)

    return {
      day: `Day ${i + 1}`,
      date: dateStr,
      weighted: Math.max(0, projected),
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
