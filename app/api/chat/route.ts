// AI Chat API — OpenAI REST (fetch) + Firebase Admin + caching + rate limiting
import { NextRequest, NextResponse } from 'next/server'
import { TOOL_DEFINITIONS, executeTool } from '@/lib/ai/toolRegistry'
import { checkRateLimit } from '@/lib/ai/rateLimiter'
import { sanitizeInput, sanitizeHistory } from '@/lib/ai/sanitize'
import { getCacheKey, saveToPersistentCache, getFromPersistentCache, formatCacheAge } from '@/lib/ai/persistentCache'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

interface ChatRequest {
  message: string
  history?: ChatMessage[]
  userId?: string
  page?: string
  role?: 'admin' | 'staff'
}

// Tools staff cannot access — sensitive business data
const STAFF_BLOCKED_TOOLS = new Set([
  'getRecentSales',
  'getTrendData',
  'getFrequentCustomers',
  'getBasketAnalysis',
  'getAllCustomers',
  'getCustomerHistory',
  'predictSales',
  'getAllShipments',
  'getActiveShipments',
  'getDeliveredShipments',
  'getPendingShipments',
])

interface OAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: OAIToolCall[]
  tool_call_id?: string
}

interface OAIToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface OAIResponse {
  choices: Array<{
    message: OAIMessage & { tool_calls?: OAIToolCall[] }
  }>
  error?: { message: string; type: string }
}

// ── System Prompt ─────────────────────────────────────────────────────────────

// Today's date, in the shop's own timezone.
//
// This matters twice over. The model has no reliable sense of the current date
// and will guess a month from seasonal wording if we do not state it outright.
// And the server may run in UTC (Vercel does), so asking the server for "today"
// can be a day off in Manila — which near a month boundary means the wrong
// season entirely.
const todayInManila = () =>
  new Date().toLocaleDateString('en-PH', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'Asia/Manila',
  })

const buildSystemPrompt = (page?: string, role?: 'admin' | 'staff') => `You are JMG, the AI assistant for JMGs Japan Surplus - a Japanese surplus retail shop located in Urdaneta City, Pangasinan, Philippines.

TODAY'S DATE: ${todayInManila()}
Use this date for anything time-related. Never infer the month or season from
the wording of tool results, and never state a month other than this one.

ABOUT THIS STORE:
- Store name: JMGs Japan Surplus
- Location: Urdaneta City, Pangasinan, Philippines
- Sells second-hand and surplus items imported from Japan
- Serves Filipino customers in Pangasinan and nearby provinces (Ilocos, La Union, Nueva Ecija)
- Products include: electronics, appliances, clothing, bags, footwear, school supplies, accessories, and home goods
- Prices are affordable for budget-conscious Filipino shoppers in the Ilocos Region
- Urdaneta City is a major commercial hub in Pangasinan — high foot traffic from surrounding towns
- The store follows Philippine retail seasonality and local Pangasinan events

PHILIPPINE SEASONAL KNOWLEDGE (use this when giving recommendations):
- September to December: "Ber months" - Christmas shopping season, highest retail period in PH
- December: PEAK month - family gift-giving, Noche Buena, Christmas parties; electronics, appliances, clothing all surge
- November: Pre-Christmas rush - All Saints Day (Undas), Bonifacio Day; gift shopping begins
- June to August: School opening - school supplies, bags, and affordable clothing in high demand
- March to May: Philippine summer - fans, cooling appliances, footwear trending
- February: Valentine's Day - accessories, clothing, bags as gifts
- January: Post-holiday slowdown - customers looking for deals

When recommending what to display or promote:
1. Check the month and apply PH seasonal context above
2. Cross-reference with actual inventory from the tool data
3. Prioritize items matching the season AND with good stock
4. Mention the specific Philippine occasion driving the recommendation
5. Highlight Japanese quality surplus items that fit the season

You have access to live store data through tools. Always call the appropriate tool before answering data questions.
${role === 'staff' ? `
USER ROLE: Staff
IMPORTANT RESTRICTIONS for staff users:
- You can answer questions about inventory, stock levels, reservations, and what to display/promote
- You CANNOT share: revenue figures, sales totals, customer names or purchase history, sales predictions, shipment costs, or any financial data
- If staff asks about revenue, sales amounts, customer data, or predictions, politely explain that this information is only available to admin users
- Say: "That information is only accessible to admin users. I can help you with inventory and stock-related questions instead."
` : `
USER ROLE: Admin (full access)
`}${page ? `\nThe user is currently on the "${page}" page of the system.\n` : ''}
TOOL SELECTION RULES (follow strictly):
- "predict", "forecast", "next week", "how much will we earn", "expected sales", "projection" -> ALWAYS call predictSales
- "trend", "this month", "month over month", "growth", "decline" -> call getTrendData
- "low stock", "restock" -> call getLowStockItems
- "out of stock", "sold out", "zero stock" -> call getOutOfStockItems
- "overview", "summary", "how is the store", "show everything", "show it all", "show me all", "show all", "what can you show" -> call getDashboardSummary
- "display", "promote", "recommend", "what to sell", "what to display", "Christmas", "season", "this month", "trending", "what is popular", "what should we sell", "what should we display" -> call getRecommendations
- "customer list", "all customers", "who are our customers" -> call getAllCustomers
- "customer history", "what did [name] buy", "purchases by [name]", "most expensive", "highest purchase" -> call getCustomerHistory with the customer name
- "shipment", "container", "delivery", "supplier" -> call getAllShipments or getActiveShipments
- "audit", "stock log", "recent activity" -> call getStockLogs
- "pair with", "goes with", "bundle", "what else should they buy", "sell together", "combo" -> call getBasketAnalysis, which reports what customers actually bought together
- VAGUE OR GENERAL QUERIES ("show all", "tell me everything", "what do you know"): ALWAYS route to getDashboardSummary

CRITICAL RULES:
- NEVER name a product that did not appear in a tool result. This applies to
  suggestions and advice, not only to figures. If you did not read the item's
  name in tool output, you may not mention it — not as an example, not as a
  recommendation, not as something to consider sourcing.
- NEVER invent, guess, or make up product names, prices, categories, or any store data
- ONLY use data returned by tool calls
- These rules apply to questions ABOUT STORE DATA - inventory, sales,
  customers, reservations, shipments, stock movements and forecasts.
- If a STORE DATA question returns nothing, say so in one sentence and stop.
  Do not answer from general knowledge and do not fill the gap with typical
  retail advice. Match the wording to what was actually asked, for example
  "No items in your inventory match that." or "There are no reservations for
  that period." A short accurate answer is better than a longer one containing
  anything you were not given.

QUESTIONS THAT NEED NO TOOL:
Some questions are not about store data and must still be answered normally.
Answer these directly and helpfully, without calling a tool and without the
"no matching data" reply:
- Greetings and small talk ("hi", "thank you")
- Questions about YOU - what you can do, your capabilities, your limits, what
  you have access to, how you work, what to ask you
- How to use the SUSTAIN system itself

WHAT YOU CAN DO (use this when asked about your capabilities):
You are a read-only assistant for this shop's own data. You can answer questions about:
- Inventory - low stock, out of stock, stock aging, search by name, category breakdown, overall summary
- Sales - today's sales, recent sales, top categories, revenue trends, items commonly bought together
- Reservations - active, pending and overdue
- Customers - customer list and an individual customer's purchase history
- Shipments - all, active, delivered and pending containers
- Stock logs - recent stock movement history
- Predictions - short-term sales outlook, and what to promote this month
You CANNOT create, edit or delete anything, and you cannot browse the internet.
Staff accounts have access to inventory and reservations; financial figures,
customer data, predictions and shipment information are limited to admins.
- NEVER expose raw database IDs, internal system fields, or raw JSON
- NEVER repeat the raw tool response — always format it into clean bullet points

HANDLING INSUFFICIENT DATA:
- If a tool returns JSON with "canPredict: false", extract the explanation/whatIsNeeded/suggestion fields and present them clearly
- Never show raw JSON — translate into a friendly readable message

RESPONSE STYLE:
- Short bullet points only — no long paragraphs
- Max 6 bullets per response
- Be direct and actionable
- Use exact numbers and names from tool results
- Mention the Philippine seasonal context when giving recommendations
- No filler phrases like "Great question!" or "I would be happy to help"

Always respond in English.`

// ── Build OpenAI tool definitions ─────────────────────────────────────────────

function buildTools(role?: 'admin' | 'staff') {
  const allowed = TOOL_DEFINITIONS.filter(t =>
    role === 'staff' ? !STAFF_BLOCKED_TOOLS.has(t.name) : true
  )
  return allowed.map(tool => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'object',
        properties: tool.parameters.properties ?? {},
        required: tool.parameters.required ?? [],
      },
    },
  }))
}

// ── OpenAI REST call ──────────────────────────────────────────────────────────

async function callOpenAI(apiKey: string, messages: OAIMessage[], withTools: boolean, role?: 'admin' | 'staff'): Promise<OAIResponse> {
  const body: Record<string, unknown> = {
    model: 'gpt-4o-mini',
    messages,
    max_tokens: 700,
    temperature: 0.3,
  }
  if (withTools) {
    body.tools = buildTools(role)
    body.tool_choice = 'auto'
  }

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  })

  const data = (await res.json()) as OAIResponse
  if (!res.ok) {
    const errMsg = data?.error?.message ?? `OpenAI error ${res.status}`
    throw new Error(errMsg)
  }
  return data
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  let body: ChatRequest | null = null

  try {
    // 1. Check API key
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) {
      return NextResponse.json({ error: 'The assistant is not currently available.' }, { status: 503 })
    }

    // 2. Parse body
    body = (await req.json()) as ChatRequest
    const rawMessage = body.message ?? ''
    const rawHistory = Array.isArray(body.history) ? body.history : []
    const currentPage = typeof body.page === 'string' ? body.page : undefined
    const userRole = body.role === 'admin' ? 'admin' : 'staff'

    // 3. Rate limiting
    const userId = body.userId ?? req.headers.get('x-forwarded-for') ?? 'anonymous'
    const { allowed, remaining } = checkRateLimit(userId)
    if (!allowed) {
      return NextResponse.json(
        { error: 'You are sending messages too quickly. Please wait a moment.' },
        { status: 429, headers: { 'X-RateLimit-Remaining': '0' } }
      )
    }

    // 4. Sanitize input
    const { safe, cleaned: message } = sanitizeInput(rawMessage)
    if (!message) {
      return NextResponse.json({ error: 'Message is required.' }, { status: 400 })
    }
    if (!safe) {
      return NextResponse.json(
        { reply: 'I can only help with store-related questions about inventory, sales, and reservations.', usedTool: null },
        { status: 200 }
      )
    }

    // 5. Sanitize history + cache key
    const history = sanitizeHistory(rawHistory)
    const cacheKey = getCacheKey(message)

    // 6. Build messages
    const messages: OAIMessage[] = [
      { role: 'system', content: buildSystemPrompt(currentPage, userRole) },
      ...history.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      { role: 'user', content: message },
    ]

    // 7. First call — may request tool calls
    const firstData = await callOpenAI(apiKey, messages, true, userRole)
    const firstMsg = firstData.choices[0].message
    const toolCalls = firstMsg.tool_calls

    let toolNames: string[] = []
    let reply = ''

    if (toolCalls && toolCalls.length > 0) {
      toolNames = toolCalls.map(tc => tc.function.name)

      // 8. Execute all tools in parallel
      const toolResults = await Promise.all(
        toolCalls.map(async tc => {
          let args: Record<string, unknown> = {}
          try { args = JSON.parse(tc.function.arguments) } catch { args = {} }
          try {
            const result = await executeTool(tc.function.name, args)
            return { id: tc.id, name: tc.function.name, result }
          } catch (toolErr) {
            console.error(`[chat] Tool "${tc.function.name}" failed:`, toolErr)
            return { id: tc.id, name: tc.function.name, result: 'Data is temporarily unavailable.' }
          }
        })
      )

      // 9. Send tool results back for final answer
      const messagesWithTools: OAIMessage[] = [
        ...messages,
        { role: 'assistant', content: null, tool_calls: toolCalls },
        ...toolResults.map(tr => ({
          role: 'tool' as const,
          tool_call_id: tr.id,
          content: tr.result,
        })),
      ]

      const secondData = await callOpenAI(apiKey, messagesWithTools, false, userRole)
      reply = secondData.choices[0].message.content ?? ''
    } else {
      reply = firstMsg.content ?? ''
    }

    // Clean any raw JSON that leaked into reply
    reply = reply
      .replace(/\{["']?\w+_response["']?:[\s\S]*?\}\s*/gm, '')
      .replace(/^\s*\{[\s\S]*?\}\s*/m, '')
      .trim()

    if (!reply) reply = "I don't have enough data to answer that right now."

    // Save to persistent cache (non-blocking)
    if (toolNames.length > 0) {
      saveToPersistentCache(cacheKey, reply, toolNames, message).catch(() => {})
    }

    return NextResponse.json(
      { reply, usedTool: toolNames[0] ?? null, usedTools: toolNames, usedLiveData: toolNames.length > 0 },
      { status: 200, headers: { 'X-RateLimit-Remaining': String(remaining) } }
    )

  } catch (error) {
    console.error('POST /api/chat error:', error)

    const msg = error instanceof Error ? error.message : ''
    const isQuota  = msg.includes('quota') || msg.includes('429') || msg.includes('rate limit') || msg.includes('insufficient_quota')

    // Quota/rate-limit: try persistent cache fallback
    if (isQuota && body) {
      const rawMessage = body.message ?? ''
      const { cleaned: message } = sanitizeInput(rawMessage)
      const cacheKey = getCacheKey(message || rawMessage)
      const cached = await getFromPersistentCache(cacheKey).catch(() => null)
      if (cached) {
        return NextResponse.json(
          {
            reply: cached.reply + `\n\n*(Showing cached response from ${formatCacheAge(cached.age)} ago — AI is temporarily busy)*`,
            usedTool: cached.usedTools[0] ?? null,
            usedTools: cached.usedTools,
            usedLiveData: false,
            fromCache: true,
          },
          { status: 200 }
        )
      }
    }

    const userMsg = isQuota
      ? 'The AI assistant is temporarily busy. Please try again in a moment.'
      : 'Something went wrong. Please try again.'

    return NextResponse.json({ error: userMsg }, { status: 500 })
  }
}
