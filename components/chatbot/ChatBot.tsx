'use client'

import React, { useEffect, useRef, useState } from 'react'
import { Bot, Send, Trash2, X } from 'lucide-react'

// ── Types ──────────────────────────────────────────────────────────────────────

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  ts: Date
}

export interface ChatContext {
  totalSales?: number
  totalRevenue?: number
  topCategory?: string
  lowStockCount?: number
  activeReservations?: number
  projectedRevenue?: number
  period?: string
}

interface ChatBotProps {
  context?: ChatContext
  /** Compact single-card mode (used inside analytics grid) */
  inline?: boolean
}

// ── Quick-ask chips ────────────────────────────────────────────────────────────

const QUICK_QUESTIONS = [
  'What are today\'s top insights?',
  'Which category should I restock?',
  'How can I reduce expired reservations?',
  'What does low stock mean for revenue?',
]

// ── Helpers ────────────────────────────────────────────────────────────────────

const uid = () => Math.random().toString(36).slice(2)

const fmtTime = (d: Date) =>
  d.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' })

// ── Message bubble ─────────────────────────────────────────────────────────────

function Bubble({ msg }: { msg: Message }) {
  const isUser = msg.role === 'user'
  return (
    <div className={'flex w-full gap-2 ' + (isUser ? 'justify-end' : 'justify-start')}>
      {!isUser && (
        <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-600">
          <Bot className="h-3.5 w-3.5 text-white" />
        </div>
      )}
      <div className={'max-w-[82%] ' + (isUser ? 'items-end' : 'items-start') + ' flex flex-col gap-0.5'}>
        <div
          className={
            'rounded-2xl px-3 py-2 text-xs leading-relaxed ' +
            (isUser
              ? 'rounded-tr-sm bg-blue-600 text-white'
              : 'rounded-tl-sm bg-slate-100 text-slate-800')
          }
        >
          {msg.content}
        </div>
        <span className="px-1 text-[10px] text-slate-400">{fmtTime(msg.ts)}</span>
      </div>
    </div>
  )
}

// ── Typing indicator ───────────────────────────────────────────────────────────

function TypingDots() {
  return (
    <div className="flex items-center gap-2">
      <div className="flex h-6 w-6 items-center justify-center rounded-full bg-blue-600">
        <Bot className="h-3.5 w-3.5 text-white" />
      </div>
      <div className="flex items-center gap-1 rounded-2xl rounded-tl-sm bg-slate-100 px-3 py-2.5">
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:0ms]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:150ms]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:300ms]" />
      </div>
    </div>
  )
}

// ── Main Component ─────────────────────────────────────────────────────────────

export default function ChatBot({ context, inline = false }: ChatBotProps) {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: uid(),
      role: 'assistant',
      content: 'Hi! I\'m JMG, your AI assistant for JMGS Japan Surplus. Ask me anything about your inventory, sales, reservations, or analytics.',
      ts: new Date(),
    },
  ])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Auto-scroll to latest message
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  const sendMessage = async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed || loading) return

    const userMsg: Message = { id: uid(), role: 'user', content: trimmed, ts: new Date() }
    setMessages((prev) => [...prev, userMsg])
    setInput('')
    setError('')
    setLoading(true)

    try {
      const history = messages.map((m) => ({ role: m.role, content: m.content }))
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: trimmed, history, context }),
      })

      const data = (await res.json()) as { reply?: string; error?: string }

      if (!res.ok || data.error) {
        throw new Error(data.error || 'Failed to get response.')
      }

      setMessages((prev) => [
        ...prev,
        { id: uid(), role: 'assistant', content: data.reply ?? '(No response)', ts: new Date() },
      ])
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Something went wrong.'
      setError(msg)
    } finally {
      setLoading(false)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void sendMessage(input)
    }
  }

  const clearChat = () => {
    setMessages([
      {
        id: uid(),
        role: 'assistant',
        content: 'Chat cleared. How can I help you?',
        ts: new Date(),
      },
    ])
    setError('')
  }

  // Height of message area differs between inline (card) and standalone
  const scrollAreaClass = inline
    ? 'h-[220px] overflow-y-auto'
    : 'h-[360px] overflow-y-auto'

  return (
    <div className="flex h-full flex-col">
      {/* ── Header ── */}
      <div className="flex items-center justify-between border-b border-slate-100 pb-2.5">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-blue-600 shadow-sm">
            <Bot className="h-4 w-4 text-white" />
          </div>
          <div>
            <p className="text-sm font-semibold text-slate-900">JMG Assistant</p>
            <div className="flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              <span className="text-[10px] text-slate-400">AI · Gemini</span>
            </div>
          </div>
        </div>
        <button
          onClick={clearChat}
          title="Clear chat"
          className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* ── Messages ── */}
      <div className={scrollAreaClass + ' space-y-3 py-3 pr-1'}>
        {messages.map((msg) => (
          <Bubble key={msg.id} msg={msg} />
        ))}
        {loading && <TypingDots />}
        <div ref={bottomRef} />
      </div>

      {/* ── Quick questions (shown only when just greeting visible) ── */}
      {messages.length === 1 && !loading && (
        <div className="flex flex-wrap gap-1.5 pb-2">
          {QUICK_QUESTIONS.map((q) => (
            <button
              key={q}
              onClick={() => void sendMessage(q)}
              className="rounded-full border border-blue-100 bg-blue-50 px-2.5 py-1 text-[11px] font-medium text-blue-600 transition-colors hover:bg-blue-100"
            >
              {q}
            </button>
          ))}
        </div>
      )}

      {/* ── Error ── */}
      {error && (
        <div className="mb-2 flex items-start gap-1.5 rounded-lg border border-red-100 bg-red-50 px-3 py-2">
          <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" />
          <p className="text-[11px] text-red-600">{error}</p>
        </div>
      )}

      {/* ── Input ── */}
      <div className="flex items-end gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 focus-within:border-blue-300 focus-within:ring-2 focus-within:ring-blue-50 transition-all">
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask about inventory, sales, reservations…"
          rows={1}
          disabled={loading}
          className="flex-1 resize-none bg-transparent text-xs text-slate-800 outline-none placeholder:text-slate-400 disabled:opacity-50"
          style={{ maxHeight: '80px' }}
        />
        <button
          onClick={() => void sendMessage(input)}
          disabled={!input.trim() || loading}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-blue-600 text-white shadow-sm transition-all hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Send className="h-3.5 w-3.5" />
        </button>
      </div>
      <p className="mt-1.5 text-center text-[10px] text-slate-300">
        Powered by Gemini · Enter to send · Shift+Enter for new line
      </p>
    </div>
  )
}
