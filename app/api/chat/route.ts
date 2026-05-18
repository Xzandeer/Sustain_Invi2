// Hybrid AI Chatbot API — Intent detection + live Firestore queries + Gemini
import { NextResponse } from 'next/server'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { collection, getDocs, orderBy, query } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { toDate, toNumber } from '@/lib/server/salesInventoryMetrics'

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

interface ChatRequest {
  message: string
  history?: ChatMessage[]
  context?: {
    totalSales?: number
    totalRevenue?: number
    topCategory?: string
    lowStockCount?: number
    activeReservations?: number
    projectedRevenue?: number
    period?: string
  }
}

type Intent =
  | 'low_stock'
  | 'inventory_summary'
  | 'today_sales'
  | 'recent_sales'
  | 'top_categories'
  | 'active_reservations'
  | 'stock_logs'
  | 'dashboard_summary'
  | 'unknown'

const INTENT_PATTERNS: Array<{ intent: Intent; patterns: RegExp[] }> = [
  { intent: 'low_stock', patterns: [/low.?stock/i, /restock/i, /running.?out/i, /out.?of.?stock/i, /need.?to.?order/i, /almost.?empty/i] },
  { intent: 'today_sales', patterns: [/today.?sale/i, /today.?revenue/i, /today.?transaction/i, /sales.?today/i, /how.?much.*today/i, /earn.*today/i] },
  { intent: 'recent_sales', patterns: [/recent.?sale/i, /this.?week.?sale/i, /this.?month.?sale/i, /sale.?summary/i, /how.?much.?did.?we.?make/i, /total.?revenue/i, /summarize.*sale/i, /sales.?performance/i] },
  { intent: 'top_categories', patterns: [/top.?categor/i, /best.?selling/i, /most.?popular/i, /which.?categor/i, /popular.?item/i, /trending/i, /top.?product/i, /demand/i] },
  { intent: 'active_reservations', patterns: [/reservation/i, /reserved/i, /pending.?claim/i, /unclaimed/i, /expir/i, /claim/i] },
  { intent: 'stock_logs', patterns: [/stock.?log/i, /audit/i, /who.?changed/i, /activity.?log/i, /stock.*history/i] },
  { intent: 'inventory_summary', patterns: [/inventory/i, /stock.?level/i, /how.?many.?items/i, /total.?stock/i, /product.?list/i, /all.?item/i] },
  { intent: 'dashboard_summary', patterns: [/overview/i, /dashboard/i, /how.?is.?the.?store/i, /business.?doing/i, /insight/i, /store.?performance/i, /summary/i, /status/i, /report/i, /what.*going.?on/i] },
]

function detectIntent(message: string): Intent {
  for (const { intent, patterns } of INTENT_PATTERNS) {
    if (patterns.some((p) => p.test(message))) return intent
  }
  return 'unknown'
}

const fmt = (n: number) =>
  `₱${n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const getSaleAmount = (s: Record<string, unknown>) =>
  toNumber(s.totalAmount ?? s.amount ?? s.total)

const getSaleDate = (s: Record<string, unknown>) =>
  toDate(s.createdAt ?? s.date ?? s.saleDate ?? s.timestamp)

async function fetchLowStock(): Promise<string> {
  const [invSnap, catSnap] = await Promise.all([getDocs(collection(db, 'inventory')), getDocs(collection(db, 'categories'))])
  const catMap = new Map(catSnap.docs.map((d) => { const data = d.data() as Record<string, unknown>; return [d.id, typeof data.name === 'string' ? data.name : d.id] }))
  const lowItems = invSnap.docs
    .filter((d) => { const data = d.data() as Record<string, unknown>; if (data.isDeleted || data.isVoided) return false; return toNumber(data.stock) <= toNumber(data.minStock, 5) })
    .map((d) => { const data = d.data() as Record<string, unknown>; const catId = typeof data.categoryId === 'string' ? data.categoryId : ''; const catName = catMap.get(catId) ?? (typeof data.categoryName === 'string' ? data.categoryName : 'Unknown'); return `- ${typeof data.name === 'string' ? data.name : d.id} (${catName}): ${toNumber(data.stock)} in stock [min: ${toNumber(data.minStock, 5)}]` })
  if (lowItems.length === 0) return '=== Low Stock Check ===\nAll items are sufficiently stocked.\n'
  return `=== Low Stock Items (${lowItems.length} need restocking) ===\n${lowItems.join('\n')}\n`
}

async function fetchInventorySummary(): Promise<string> {
  const [invSnap, catSnap] = await Promise.all([getDocs(collection(db, 'inventory')), getDocs(collection(db, 'categories'))])
  const catMap = new Map(catSnap.docs.map((d) => { const data = d.data() as Record<string, unknown>; return [d.id, typeof data.name === 'string' ? data.name : d.id] }))
  let totalValue = 0, deletedCount = 0
  const byCategory: Record<string, { count: number; stock: number }> = {}
  invSnap.docs.forEach((d) => {
    const data = d.data() as Record<string, unknown>
    if (data.isDeleted) { deletedCount++; return }
    totalValue += toNumber(data.stock) * toNumber(data.price)
    const catId = typeof data.categoryId === 'string' ? data.categoryId : ''
    const cat = catMap.get(catId) ?? (typeof data.categoryName === 'string' ? data.categoryName : 'Unknown')
    if (!byCategory[cat]) byCategory[cat] = { count: 0, stock: 0 }
    byCategory[cat].count++; byCategory[cat].stock += toNumber(data.stock)
  })
  const activeCount = invSnap.docs.length - deletedCount
  const catLines = Object.entries(byCategory).sort((a, b) => b[1].stock - a[1].stock).map(([cat, { count, stock }]) => `- ${cat}: ${count} variants, ${stock} units`).join('\n')
  return `=== Inventory Summary ===\nActive: ${activeCount} items | Deleted: ${deletedCount}\nTotal value: ${fmt(totalValue)}\n\nBy category:\n${catLines || '(none)'}\n`
}

async function fetchTodaySales(): Promise<string> {
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const salesSnap = await getDocs(collection(db, 'sales'))
  const todaySales = salesSnap.docs.map((d) => ({ id: d.id, ...d.data() } as Record<string, unknown>)).filter((s) => { const d = getSaleDate(s); return d !== null && d >= today })
  const dayLabel = today.toLocaleDateString('en-PH', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  if (todaySales.length === 0) return `=== Today's Sales (${dayLabel}) ===\nNo transactions recorded today yet.\n`
  const totalRevenue = todaySales.reduce((sum, s) => sum + getSaleAmount(s), 0)
  const totalItems = todaySales.reduce((sum, s) => { const items = Array.isArray(s.items) ? (s.items as Array<Record<string, unknown>>) : []; return sum + items.reduce((acc, i) => acc + toNumber(i.quantity, 1), 0) }, 0)
  const lines = todaySales.slice(0, 8).map((s) => { const txn = typeof s.transactionNumber === 'string' ? s.transactionNumber : (s.id as string).slice(0, 8); const items = Array.isArray(s.items) ? (s.items as Array<Record<string, unknown>>).map((i) => `${typeof i.name === 'string' ? i.name : 'item'} x${toNumber(i.quantity, 1)}`).join(', ') : 'N/A'; return `- #${txn}: ${fmt(getSaleAmount(s))} | ${items}` })
  return `=== Today's Sales (${dayLabel}) ===\nTransactions: ${todaySales.length} | Revenue: ${fmt(totalRevenue)} | Items sold: ${totalItems}\n\n${lines.join('\n')}${todaySales.length > 8 ? `\n...and ${todaySales.length - 8} more` : ''}\n`
}

async function fetchRecentSales(days = 30): Promise<string> {
  const since = new Date(); since.setDate(since.getDate() - days); since.setHours(0, 0, 0, 0)
  const salesSnap = await getDocs(collection(db, 'sales'))
  const recent = salesSnap.docs.map((d) => ({ id: d.id, ...d.data() } as Record<string, unknown>)).filter((s) => { const d = getSaleDate(s); return d !== null && d >= since })
  if (recent.length === 0) return `=== Sales (Last ${days} days) ===\nNo sales found.\n`
  const totalRevenue = recent.reduce((sum, s) => sum + getSaleAmount(s), 0)
  const byDay: Record<string, number> = {}
  recent.forEach((s) => { const d = getSaleDate(s); if (!d) return; const key = d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric' }); byDay[key] = (byDay[key] ?? 0) + getSaleAmount(s) })
  const topDays = Object.entries(byDay).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([date, amt]) => `- ${date}: ${fmt(amt)}`).join('\n')
  return `=== Sales Summary (Last ${days} Days) ===\nTransactions: ${recent.length}\nTotal Revenue: ${fmt(totalRevenue)}\nAvg per transaction: ${fmt(totalRevenue / recent.length)}\n\nTop revenue days:\n${topDays}\n`
}

async function fetchTopCategories(): Promise<string> {
  const salesSnap = await getDocs(collection(db, 'sales'))
  const catData: Record<string, { revenue: number; units: number; txns: number }> = {}
  salesSnap.docs.forEach((d) => { const data = d.data() as Record<string, unknown>; const items = Array.isArray(data.items) ? (data.items as Array<Record<string, unknown>>) : []; items.forEach((item) => { const cat = (typeof item.categoryName === 'string' ? item.categoryName : null) ?? (typeof item.category === 'string' ? item.category : 'Unknown'); if (!catData[cat]) catData[cat] = { revenue: 0, units: 0, txns: 0 }; catData[cat].revenue += toNumber(item.price) * toNumber(item.quantity, 1); catData[cat].units += toNumber(item.quantity, 1); catData[cat].txns++ }) })
  if (Object.keys(catData).length === 0) return '=== Category Performance ===\nNo sales data yet.\n'
  const sorted = Object.entries(catData).sort((a, b) => b[1].revenue - a[1].revenue).slice(0, 8).map(([cat, { revenue, units }], i) => `${i + 1}. ${cat}: ${fmt(revenue)} | ${units} units`)
  return `=== Top-Selling Categories (All Time) ===\n${sorted.join('\n')}\n`
}

async function fetchReservations(): Promise<string> {
  const resSnap = await getDocs(collection(db, 'reservations'))
  const now = new Date()
  const all = resSnap.docs.map((d) => ({ id: d.id, ...d.data() } as Record<string, unknown>))
  const active = all.filter((r) => { const s = (typeof r.status === 'string' ? r.status : '').toLowerCase(); return s === 'active' || s === 'pending' || s === 'reserved' })
  const expired = all.filter((r) => { const s = (typeof r.status === 'string' ? r.status : '').toLowerCase(); if (s === 'expired') return true; const exp = toDate(r.expiresAt ?? r.expiration ?? r.expirationDate); return !!(exp && exp < now && s !== 'claimed' && s !== 'cancelled') })
  const expiringSoon = active.filter((r) => { const exp = toDate(r.expiresAt ?? r.expiration ?? r.expirationDate); if (!exp) return false; return (exp.getTime() - now.getTime()) / 3_600_000 <= 48 })
  const lines = active.slice(0, 8).map((r) => { const exp = toDate(r.expiresAt ?? r.expiration ?? r.expirationDate); const cd = r.customerDetails; const customerName = (cd && typeof cd === 'object' && 'fullName' in cd && typeof (cd as Record<string, unknown>).fullName === 'string') ? (cd as Record<string, unknown>).fullName as string : typeof r.customer === 'string' ? r.customer : 'Unknown'; const items = Array.isArray(r.items) ? (r.items as Array<Record<string, unknown>>).map((i) => `${typeof i.name === 'string' ? i.name : 'item'} x${toNumber(i.quantity, 1)}`).join(', ') : 'N/A'; const txn = typeof r.transactionNumber === 'string' ? r.transactionNumber : (r.id as string).slice(0, 8); const expStr = exp ? exp.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }) : 'No expiry'; return `- #${txn} | ${customerName} | ${items} | Expires: ${expStr}` })
  return `=== Reservations Status ===\nActive: ${active.length} | Expired: ${expired.length} | Expiring within 48h: ${expiringSoon.length}\n\n${active.length > 0 ? 'Active:\n' + lines.join('\n') : 'No active reservations.'}\n${active.length > 8 ? `\n...and ${active.length - 8} more` : ''}\n`
}

async function fetchStockLogs(): Promise<string> {
  const logsSnap = await getDocs(query(collection(db, 'stockLogs'), orderBy('createdAt', 'desc')))
  const lines = logsSnap.docs.slice(0, 15).map((d) => { const data = d.data() as Record<string, unknown>; const date = toDate(data.createdAt); const dateStr = date ? date.toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'N/A'; return `- [${dateStr}] ${typeof data.actionType === 'string' ? data.actionType : 'unknown'} | ${typeof data.itemName === 'string' ? data.itemName : 'item'} | by ${typeof data.userName === 'string' ? data.userName : 'system'} | qty: ${String(data.quantityBefore ?? '?')} → ${String(data.quantityAfter ?? '?')}` })
  if (lines.length === 0) return '=== Stock Logs ===\nNo entries found.\n'
  return `=== Recent Stock Activity (Last 15) ===\n${lines.join('\n')}\n`
}

async function fetchDashboardSummary(): Promise<string> {
  const [invSnap, salesSnap, resSnap] = await Promise.all([getDocs(collection(db, 'inventory')), getDocs(collection(db, 'sales')), getDocs(collection(db, 'reservations'))])
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1)
  const active = invSnap.docs.filter((d) => !(d.data() as Record<string, unknown>).isDeleted)
  const lowStock = active.filter((d) => { const data = d.data() as Record<string, unknown>; return toNumber(data.stock) <= toNumber(data.minStock, 5) })
  const outOfStock = active.filter((d) => toNumber((d.data() as Record<string, unknown>).stock) === 0)
  const allSales = salesSnap.docs.map((d) => ({ id: d.id, ...d.data() } as Record<string, unknown>))
  const todaySales = allSales.filter((s) => { const d = getSaleDate(s); return d !== null && d >= today })
  const monthSales = allSales.filter((s) => { const d = getSaleDate(s); return d !== null && d >= monthStart })
  const todayRevenue = todaySales.reduce((sum, s) => sum + getSaleAmount(s), 0)
  const monthRevenue = monthSales.reduce((sum, s) => sum + getSaleAmount(s), 0)
  const activeRes = resSnap.docs.filter((d) => { const s = ((d.data() as Record<string, unknown>).status as string ?? '').toLowerCase(); return s === 'active' || s === 'pending' || s === 'reserved' })
  const monthLabel = today.toLocaleDateString('en-PH', { month: 'long', year: 'numeric' })
  return `=== Store Overview ===\nInventory: ${active.length} active | ${lowStock.length} low stock | ${outOfStock.length} out of stock\nToday's Revenue: ${fmt(todayRevenue)} (${todaySales.length} transactions)\n${monthLabel} Revenue: ${fmt(monthRevenue)} (${monthSales.length} transactions)\nActive Reservations: ${activeRes.length}\n`
}

async function fetchDataForIntent(intent: Intent): Promise<string> {
  switch (intent) {
    case 'low_stock':           return fetchLowStock()
    case 'inventory_summary':   return fetchInventorySummary()
    case 'today_sales':         return fetchTodaySales()
    case 'recent_sales':        return fetchRecentSales(30)
    case 'top_categories':      return fetchTopCategories()
    case 'active_reservations': return fetchReservations()
    case 'stock_logs':          return fetchStockLogs()
    case 'dashboard_summary':   return fetchDashboardSummary()
    default:                    return ''
  }
}

const SYSTEM_PROMPT = `You are JMG, a smart AI assistant for JMGS Japan Surplus — a retail surplus store inventory and POS management system based in the Philippines.

You help store administrators with inventory management, sales queries, reservation management, analytics, stock logs, and general surplus retail advice.

Tone: Professional, concise, helpful. Keep responses actionable.

When live data is provided in "=== ... ===" blocks, use it for accurate specific answers. Use bullet points or short lists when presenting multiple items. Acknowledge that live data reflects real current store data.

Always respond in English. Do NOT make up numbers unless provided in the data block.`

export async function POST(req: Request) {
  try {
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) {
      return NextResponse.json({ error: 'AI assistant is not configured. Please add GEMINI_API_KEY.' }, { status: 503 })
    }

    const body = (await req.json()) as ChatRequest
    const { message, history = [], context } = body

    if (!message || typeof message !== 'string' || !message.trim()) {
      return NextResponse.json({ error: 'Message is required.' }, { status: 400 })
    }

    const intent = detectIntent(message)
    let liveData = ''
    let usedLiveData = false

    if (intent !== 'unknown') {
      try {
        liveData = await fetchDataForIntent(intent)
        if (liveData) usedLiveData = true
      } catch (fetchErr) {
        console.error(`[chat] Firestore fetch failed for intent "${intent}":`, fetchErr)
      }
    }

    let contextBlock = ''
    if (!liveData && context) {
      const lines: string[] = ['=== Dashboard Snapshot ===']
      if (context.period)                 lines.push(`Period: ${context.period}`)
      if (context.totalSales != null)     lines.push(`Total Transactions: ${context.totalSales}`)
      if (context.totalRevenue != null)   lines.push(`Total Revenue: ₱${context.totalRevenue.toLocaleString('en-PH', { minimumFractionDigits: 2 })}`)
      if (context.topCategory)            lines.push(`Top-Selling Category: ${context.topCategory}`)
      if (context.lowStockCount != null)  lines.push(`Low Stock Items: ${context.lowStockCount}`)
      if (context.activeReservations != null) lines.push(`Active Reservations: ${context.activeReservations}`)
      if (context.projectedRevenue != null)   lines.push(`Projected Revenue: ₱${context.projectedRevenue.toLocaleString('en-PH', { minimumFractionDigits: 2 })}`)
      contextBlock = lines.join('\n') + '\n=========================\n\n'
    }

    const genAI = new GoogleGenerativeAI(apiKey)
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash', systemInstruction: SYSTEM_PROMPT })
    const chat = model.startChat({
      history: history.map((msg) => ({ role: msg.role === 'assistant' ? 'model' : 'user', parts: [{ text: msg.content }] })),
    })

    const result = await chat.sendMessage((liveData || contextBlock) + message.trim())
    const reply = result.response.text()

    return NextResponse.json({ reply, usedLiveData, intent }, { status: 200 })
  } catch (error) {
    console.error('POST /api/chat error:', error)
    return NextResponse.json({ error: `Failed to get AI response: ${error instanceof Error ? error.message : 'Unknown error'}` }, { status: 500 })
  }
}
