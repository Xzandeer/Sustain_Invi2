// AI Chatbot API — powered by Google Gemini
import { NextResponse } from 'next/server'
import { GoogleGenerativeAI } from '@google/generative-ai'

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

const SYSTEM_PROMPT = `You are JMG, a smart AI assistant for JMGS Japan Surplus — a retail surplus store inventory and POS management system based in the Philippines.

You help store administrators with:
- Inventory management (stock levels, conditions, categories, voiding items)
- Sales and transaction queries (receipts, revenue, trends)
- Reservation management (active, expired, cancelled reservations)
- Analytics and demand forecasting (category trends, projections)
- Stock logs and audit trails
- General business advice for a surplus retail store

Tone: Professional, concise, and helpful. Use plain language. Keep responses short and actionable — 2 to 5 sentences unless a detailed answer is needed.

When the user asks about their data, use the live context provided. If no context is given, answer based on general surplus retail knowledge.

Always respond in English. If you don't know something specific about their system, say so clearly and offer a helpful alternative.

DO NOT make up specific numbers unless they are provided in the context.`

export async function POST(req: Request) {
  try {
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) {
      return NextResponse.json(
        { error: 'AI assistant is not configured. Please add a GEMINI_API_KEY to your environment.' },
        { status: 503 }
      )
    }

    const body = (await req.json()) as ChatRequest
    const { message, history = [], context } = body

    if (!message || typeof message !== 'string' || !message.trim()) {
      return NextResponse.json({ error: 'Message is required.' }, { status: 400 })
    }

    // Build context string from live analytics data
    let contextBlock = ''
    if (context) {
      const lines: string[] = ['=== Live System Snapshot ===']
      if (context.period) lines.push('Period: ' + context.period)
      if (context.totalSales != null) lines.push('Total Transactions: ' + context.totalSales)
      if (context.totalRevenue != null) lines.push('Total Revenue: ₱' + context.totalRevenue.toLocaleString('en-PH', { minimumFractionDigits: 2 }))
      if (context.topCategory) lines.push('Top-Selling Category: ' + context.topCategory)
      if (context.lowStockCount != null) lines.push('Low Stock Items: ' + context.lowStockCount)
      if (context.activeReservations != null) lines.push('Active Reservations: ' + context.activeReservations)
      if (context.projectedRevenue != null) lines.push('Projected Revenue (forecast): ₱' + context.projectedRevenue.toLocaleString('en-PH', { minimumFractionDigits: 2 }))
      contextBlock = lines.join('\n') + '\n=========================\n\n'
    }

    const genAI = new GoogleGenerativeAI(apiKey)
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash',
      systemInstruction: SYSTEM_PROMPT,
    })

    // Build chat history for multi-turn conversation
    const chat = model.startChat({
      history: history.map((msg) => ({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }],
      })),
    })

    const fullMessage = contextBlock + message.trim()
    const result = await chat.sendMessage(fullMessage)
    const reply = result.response.text()

    return NextResponse.json({ reply }, { status: 200 })
  } catch (error) {
    console.error('POST /api/chat error:', error)
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: 'Failed to get AI response: ' + message }, { status: 500 })
  }
}
