// AI Chat API — Gemini function calling + Firebase Admin + caching + rate limiting
import { NextRequest, NextResponse } from 'next/server'
import { GoogleGenerativeAI, FunctionDeclarationsTool, FunctionDeclaration, SchemaType } from '@google/generative-ai'
import { TOOL_DEFINITIONS, executeTool } from '@/lib/ai/toolRegistry'
import { checkRateLimit } from '@/lib/ai/rateLimiter'
import { sanitizeInput, sanitizeHistory } from '@/lib/ai/sanitize'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

interface ChatRequest {
  message: string
  history?: ChatMessage[]
  userId?: string
}

// ── System Prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are JMG, the AI assistant for JMGS Japan Surplus — a retail surplus store in the Philippines.

You have access to live store data through tools. Always call the appropriate tool before answering data questions.

TOOL SELECTION RULES (follow strictly):
- "predict", "forecast", "next week", "how much will we earn", "expected sales", "projection" → ALWAYS call predictSales
- "trend", "this month", "month over month", "growth", "decline" → call getTrendData
- "low stock", "restock", "out of stock" → call getLowStockItems
- "overview", "summary", "how is the store" → call getDashboardSummary
- "display", "promote", "recommend", "Christmas", "season" → call getRecommendations

CRITICAL RULES:
- NEVER invent, guess, or make up product names, prices, categories, or any store data
- ONLY use data returned by tool calls
- If a tool returns no data, say so clearly in one sentence
- NEVER expose raw database IDs, internal system fields, or raw JSON
- NEVER repeat the raw tool response — always format it into clean bullet points

RESPONSE STYLE:
- Short bullet points only — no long paragraphs
- Max 5 bullets per response
- Be direct and actionable
- Use exact numbers and names from tool results
- No filler phrases like "Great question!" or "I'd be happy to help"

Always respond in English.`

// ── Map tool definitions to Gemini schema format ──────────────────────────────

function buildGeminiTools(): FunctionDeclarationsTool[] {
  const declarations: FunctionDeclaration[] = TOOL_DEFINITIONS.map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: {
      type: SchemaType.OBJECT,
      properties: Object.fromEntries(
        Object.entries(tool.parameters.properties ?? {}).map(([key, val]) => {
          const v = val as { type: string; description: string }
          return [key, { type: v.type === 'number' ? SchemaType.NUMBER : SchemaType.STRING, description: v.description }]
        })
      ),
      required: tool.parameters.required ?? [],
    },
  }))
  return [{ functionDeclarations: declarations }] as FunctionDeclarationsTool[]
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    // 1. Check API key
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) {
      return NextResponse.json({ error: 'The assistant is not currently available.' }, { status: 503 })
    }

    // 2. Parse body
    const body = (await req.json()) as ChatRequest
    const rawMessage = body.message ?? ''
    const rawHistory = Array.isArray(body.history) ? body.history : []

    // 3. Rate limiting — use userId or IP
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

    // 5. Sanitize and trim history
    const history = sanitizeHistory(rawHistory)

    // 6. Init Gemini
    const genAI = new GoogleGenerativeAI(apiKey)
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash-lite',
      systemInstruction: SYSTEM_PROMPT,
      generationConfig: { maxOutputTokens: 400, temperature: 0.3 },
    })

    const geminiTools = buildGeminiTools()

    // 7. Build chat history in Gemini format
    // Must start with 'user' and alternate — drop leading assistant messages
    const validHistory = history.filter(m => m.role === 'user' || m.role === 'assistant')
    const firstUserIdx = validHistory.findIndex(m => m.role === 'user')
    const geminiHistory = (firstUserIdx === -1 ? [] : validHistory.slice(firstUserIdx))
      .map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }))

    // 8. First Gemini call — may return a function call request
    const chat = model.startChat({ history: geminiHistory, tools: geminiTools })
    const firstResult = await chat.sendMessage(message)
    const firstResponse = firstResult.response

    // 9. Check if Gemini wants to call a tool
    const functionCalls = firstResponse.functionCalls()
    let toolName: string | null = null
    let reply = ''

    if (functionCalls && functionCalls.length > 0) {
      const call = functionCalls[0]
      toolName = call.name
      const toolArgs = (call.args ?? {}) as Record<string, unknown>

      // 10. Execute the tool
      let toolResult: string
      try {
        toolResult = await executeTool(call.name, toolArgs)
      } catch (toolErr) {
        console.error(`[chat] Tool "${call.name}" failed:`, toolErr)
        toolResult = 'Data is temporarily unavailable.'
      }

      // 11. Send tool result back to Gemini for final answer
      const secondResult = await chat.sendMessage([
        {
          functionResponse: {
            name: call.name,
            response: { result: toolResult },
          },
        },
      ])
      reply = secondResult.response.text()
    } else {
      // No tool needed — direct answer
      reply = firstResponse.text()
    }

    // Strip any raw JSON tool output that leaked into the reply
    reply = reply
      .replace(/\{["']?\w+_response["']?:.*?\}\s*/gs, '')  // remove tool response blobs
      .replace(/^\s*\{[\s\S]*?\}\s*/m, '')                  // remove leading JSON objects
      .trim()

    if (!reply || !reply.trim()) {
      reply = 'I don\'t have enough data to answer that right now.'
    }

    return NextResponse.json(
      { reply, usedTool: toolName, usedLiveData: toolName !== null },
      {
        status: 200,
        headers: { 'X-RateLimit-Remaining': String(remaining) },
      }
    )
  } catch (error) {
    console.error('POST /api/chat error:', error)

    const msg = error instanceof Error ? error.message : ''
    const isQuota = msg.includes('429') || msg.includes('quota') || msg.toLowerCase().includes('resource exhausted') || msg.includes('rate')

    // Auto-retry once on quota errors after 3s
    if (isQuota) {
      try {
        await new Promise(r => setTimeout(r, 3000))
        // Re-invoke with same request — simplified retry
        return NextResponse.json(
          { error: 'The assistant is a bit busy right now. Please try again in a moment.' },
          { status: 429 }
        )
      } catch {
        // fall through
      }
    }

    return NextResponse.json(
      { error: 'The assistant is not currently available. Please try again later.' },
      { status: 500 }
    )
  }
}
