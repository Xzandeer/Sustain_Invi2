import { getLowStockItems, getInventorySummary, getStockAging, searchInventory, getInventoryByCategory, getOutOfStockItems } from './tools/inventory'
import { getActiveReservations, getOverdueReservations, getPendingReservations } from './tools/reservations'
import { getTodaySales, getRecentSales, getTopCategories, getTrendData, getFrequentCustomers, getBasketAnalysis, getDashboardSummary, getRecommendations } from './tools/sales'
import { getStockLogs } from './tools/stockLogs'
import { predictSales } from './tools/prediction'
import { getAllCustomers, getCustomerHistory } from './tools/customers'
import { getAllShipments, getActiveShipments, getDeliveredShipments, getPendingShipments } from './tools/containers'
import { searchWebTrends } from './tools/webSearch'

// Tool definitions sent to Gemini
export const TOOL_DEFINITIONS = [

  // ── Inventory ──────────────────────────────────────────────────────────────
  {
    name: 'getLowStockItems',
    description: 'Get items that are running low on stock (at or below minimum). Use when asked about restocking, low stock, or items that need ordering.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'getOutOfStockItems',
    description: 'Get items that are completely out of stock (zero units). Use when specifically asked about out-of-stock, sold-out, or unavailable items.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'getInventorySummary',
    description: 'Get a full summary of all inventory: total items, total value, and category breakdown.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'getStockAging',
    description: 'Get items sitting in stock for 30+ days without selling. Use for slow-moving, dead stock, or aging inventory questions.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'searchInventory',
    description: 'Search for a specific item in inventory by name or keyword.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The product name or keyword to search for' },
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

  // ── Sales ──────────────────────────────────────────────────────────────────
  {
    name: 'getTodaySales',
    description: "Get today's sales transactions and revenue total.",
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'getRecentSales',
    description: 'Get sales summary for the last N days. Use for weekly (7), monthly (30), or custom period revenue questions.',
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
    description: 'Get the best-selling product categories ranked by revenue. Use when asked what sells most or for category performance.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'getTrendData',
    description: 'Get 6-month revenue trend and month-over-month comparison. Use for trend, growth, or historical performance questions.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'getFrequentCustomers',
    description: 'Get the most frequent customers ranked by number of purchases and total spend.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'getBasketAnalysis',
    description: 'Analyze which items are commonly bought together and what the most purchased individual items are.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'getDashboardSummary',
    description: 'Get a full store overview: inventory health, today revenue, monthly revenue, and active reservations. Use for general "how is the store" questions.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'getRecommendations',
    description: 'Get display and promotion recommendations based on current stock and sales trends. Use for seasonal questions, what to display, or what to promote.',
    parameters: { type: 'object', properties: {}, required: [] },
  },

  // ── Reservations ───────────────────────────────────────────────────────────
  {
    name: 'getActiveReservations',
    description: 'Get all currently active and pending reservations including those expiring soon.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'getOverdueReservations',
    description: 'Get reservations that have passed their expiry date and not been claimed.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'getPendingReservations',
    description: 'Get reservations in a pending state waiting for customer action.',
    parameters: { type: 'object', properties: {}, required: [] },
  },

  // ── Customers ──────────────────────────────────────────────────────────────
  {
    name: 'getAllCustomers',
    description: 'Get a list of all customers derived from sales and reservation records, including total spent and order count.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'getCustomerHistory',
    description: 'Get the full purchase and reservation history for a specific customer by name or email.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The customer name or email to look up' },
      },
      required: ['name'],
    },
  },

  // ── Shipments / Containers ─────────────────────────────────────────────────
  {
    name: 'getAllShipments',
    description: 'Get all supplier shipments and containers with their status, cost, and arrival date.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'getActiveShipments',
    description: 'Get currently active, in-transit, or pending shipments from suppliers.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'getDeliveredShipments',
    description: 'Get completed and delivered shipment containers.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'getPendingShipments',
    description: 'Get shipments that have not yet arrived or been processed.',
    parameters: { type: 'object', properties: {}, required: [] },
  },

  // ── Stock Logs ─────────────────────────────────────────────────────────────
  {
    name: 'getStockLogs',
    description: 'Get the recent stock activity log and audit trail of inventory movements.',
    parameters: { type: 'object', properties: {}, required: [] },
  },

  // ── Prediction ─────────────────────────────────────────────────────────────
  {
    name: 'predictSales',
    description: 'ALWAYS use this tool when the user asks about: predict, forecast, next week sales, how much will we earn, expected revenue, projection, will sales go up, estimate future sales. This is the ONLY tool that can answer prediction questions.',
    parameters: { type: 'object', properties: {}, required: [] },
  },

  // ── Web Search ─────────────────────────────────────────────────────────────
  {
    name: 'searchWebTrends',
    description: 'Search the web for trending products and items in the Philippines, then cross-reference with store inventory. Use when asked about: what is trending online, what is popular in PH right now, what should we stock based on trends, web trends, online trends, social media trends, popular items in Philippines.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query for trending items, e.g. "trending gadgets", "popular school items", "best selling Christmas gifts Philippines"' },
      },
      required: ['query'],
    },
  },
]

// ── Execute a tool by name ─────────────────────────────────────────────────────

export async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    // Inventory
    case 'getLowStockItems':        return getLowStockItems()
    case 'getOutOfStockItems':      return getOutOfStockItems()
    case 'getInventorySummary':     return getInventorySummary()
    case 'getStockAging':           return getStockAging()
    case 'searchInventory':         return searchInventory(String(args.query ?? ''))
    case 'getInventoryByCategory':  return getInventoryByCategory(String(args.category ?? ''))
    // Sales
    case 'getTodaySales':           return getTodaySales()
    case 'getRecentSales':          return getRecentSales(typeof args.days === 'number' ? args.days : 30)
    case 'getTopCategories':        return getTopCategories()
    case 'getTrendData':            return getTrendData()
    case 'getFrequentCustomers':    return getFrequentCustomers()
    case 'getBasketAnalysis':       return getBasketAnalysis()
    case 'getDashboardSummary':     return getDashboardSummary()
    case 'getRecommendations':      return getRecommendations()
    // Reservations
    case 'getActiveReservations':   return getActiveReservations()
    case 'getOverdueReservations':  return getOverdueReservations()
    case 'getPendingReservations':  return getPendingReservations()
    // Customers
    case 'getAllCustomers':         return getAllCustomers()
    case 'getCustomerHistory':      return getCustomerHistory(String(args.name ?? ''))
    // Shipments
    case 'getAllShipments':         return getAllShipments()
    case 'getActiveShipments':      return getActiveShipments()
    case 'getDeliveredShipments':   return getDeliveredShipments()
    case 'getPendingShipments':     return getPendingShipments()
    // Logs
    case 'getStockLogs':            return getStockLogs()
    // Prediction
    case 'predictSales':            return predictSales()
    // Web Search
    case 'searchWebTrends':         return searchWebTrends(String(args.query ?? ''))
    default:                        return `Unknown tool: ${name}`
  }
}
