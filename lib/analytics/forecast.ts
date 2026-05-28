// Analytics forecasting - predicts future sales based on historical trends

/**
 * Calculate N-day moving average from sales data
 * Smooths out daily fluctuations to show true trend (used for demand forecasting)
 */
export function calculateMovingAverage(
  data: number[],
  windowSize: number
): number[] {
  const averages: number[] = []

  for (let i = 0; i < data.length; i++) {
    // For initial days (less than windowSize), return original value
    if (i < windowSize - 1) {
      averages.push(data[i])
    } else {
      // Calculate average of last windowSize days
      const window = data.slice(i - windowSize + 1, i + 1)
      const avg = window.reduce((a, b) => a + b, 0) / windowSize
      averages.push(Math.round(avg))
    }
  }

  return averages
}

/**
 * Generate simple forecast for next N days
 * Uses last moving average value as projection (assumes trend continues)
 */
export function generateForecast(movingAverages: number[], days: number = 7): number[] {
  const forecast: number[] = []
  const lastAverage = movingAverages[movingAverages.length - 1]

  // Repeat last average for each forecast day
  for (let i = 0; i < days; i++) {
    forecast.push(lastAverage)
  }

  return forecast
}
