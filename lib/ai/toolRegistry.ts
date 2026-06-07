import { getLowStockItems, getInventorySummary, getStockAging, searchInventory, getInventoryByCategory } from './tools/inventory'
import { getActiveReservations, getOverdueReservations, getPendingReservations } from './tools/reservations'
import { getTodaySales, getRecentSales, getTopCategories, getTrendData, getFrequentCustomers, getBasketAnalysis, getDashboardSummary, getRecommendations } from './tools/sales'
import { getStockLogs } from './tools/stockLogs'
import { predictSales } from './tools/prediction'

// Tool definitions sent to Gemini — tells it what tools are available and when to use them
export const TOOL_DEFINITIONS = [
  {
    name: 'getLowStockItems',
    description: 'Get items that are running low on stock or out of stock. Use when asked about restocking, low stock, or items that need to be ordered.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'getInventorySummary',
    description: 'Get a summary of all inventory including total items, value, and category breakdown.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'getStockAging',
    description: 'Get items that have been sitting in stock for a long time (30+ days) without selling. Use for slow-moving or dead stock questions.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'searchInventory',
    description: 'Search for specific items in inventory by name or category.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The product name or category to search for' },
      },
      required: ['query'],
    },
  },
  {
    name: 'getInventoryByCategory',
    description: 'Get all inventory items in a specific category.',
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'The category name to filter by' },
      },
      required: ['category'],
    },
  },
  {
    name: 'getActiveReservations',
    description: 'Get all active and pending reservations, including those expiring soon.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'getOverdueReservations',
    description: 'Get reservations that have passed their expiry date and not been claimed.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'getPendingReservations',
    description: 'Get reservations that are in a pending state.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'getTodaySales',
    description: "Get today's sales transactions and revenue.",
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'getRecentSales',
    description: 'Get sales summary for the last N days. Use for weekly, monthly, or period-based revenue questions.',
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Number of days to look back (e.g. 7, 30, 90)' },
      },
      required: [],
    },
  },
  {
    name: 'getTopCategories',
    description: 'Get the top-selling product categories by revenue. Use when asked what sells most or category performance.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'getTrendData',
    description: 'Get 6-month revenue trend and month-over-month comparison. Use for trend, growth, decline, or prediction questions.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'getFrequentCustomers',
    description: 'Get the most frequent customers ranked by purchase count.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'getBasketAnalysis',
    description: 'Analyze which items are commonly bought together and most purchased items.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'getDashboardSummary',
    description: 'Get an overall store overview including inventory health, today and monthly revenue, and active reservations.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'getRecommendations',
    description: 'Get display and promotion recommendations based on current stock and sales trends. Use for seasonal questions, what to display, what to promote.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'getStockLogs',
    description: 'Get recent stock activity and audit log entries.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'predictSales',
    description: 'ALWAYS use this tool when the user asks about: predict, forecast, next week sales, how much will we earn, expected revenue, projection, will sales go up, estimate future sales. This is the ONLY tool that can answer prediction questions.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
]

// Execute a tool by name with given args
export async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'getLowStockItems':        return getLowStockItems()
    case 'getInventorySummary':     return getInventorySummary()
    case 'getStockAging':           return getStockAging()
    case 'searchInventory':         return searchInventory(String(args.query ?? ''))
    case 'getInventoryByCategory':  return getInventoryByCategory(String(args.category ?? ''))
    case 'getActiveReservations':   return getActiveReservations()
    case 'getOverdueReservations':  return getOverdueReservations()
    case 'getPendingReservations':  return getPendingReservations()
    case 'getTodaySales':           return getTodaySales()
    case 'getRecentSales':          return getRecentSales(typeof args.days === 'number' ? args.days : 30)
    case 'getTopCategories':        return getTopCategories()
    case 'getTrendData':            return getTrendData()
    case 'getFrequentCustomers':    return getFrequentCustomers()
    case 'getBasketAnalysis':       return getBasketAnalysis()
    case 'getDashboardSummary':     return getDashboardSummary()
    case 'getRecommendations':      return getRecommendations()
    case 'getStockLogs':            return getStockLogs()
    case 'predictSales':            return predictSales()
    default:                        return `Unknown tool: ${name}`
  }
}
