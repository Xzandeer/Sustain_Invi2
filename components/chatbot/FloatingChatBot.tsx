'use client'

import React, { useEffect, useRef, useState } from 'react'
import { Bot, ChevronDown, RotateCcw, Send, Sparkles, X } from 'lucide-react'

// ── Types ──────────────────────────────────────────────────────────────────────

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  ts: Date
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const uid = () => Math.random().toString(36).slice(2)

const fmtTime = (d: Date) =>
  d.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' })

const GREETING: Message = {
  id: 'greeting',
  role: 'assistant',
  content:
    "Hi! I'm JMG, your AI assistant for JMGS Japan Surplus. Ask me anything about inventory, sales, reservations, or analytics.",
  ts: new Date(),
}

const QUICK_QUESTIONS = [
  'What should I restock?',
  'Summarize today\'s sales',
  'How to handle expired reservations?',
  'Which category sells the most?',
]

// ── Typing dots ────────────────────────────────────────────────────────────────

function TypingDots() {
  return (
    <div className="flex items-end gap-2">
      <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-600">
        <Bot className="h-3.5 w-3.5 text-white" />
      </div>
      <div className="flex items-center gap-1 rounded-2xl rounded-bl-none bg-slate-100 px-3 py-2.5">
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:0ms]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:150ms]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:300ms]" />
      </div>
    </div>
  )
}

// ── Bubble ─────────────────────────────────────────────────────────────────────

function Bubble({ msg }: { msg: Message }) {
  const isUser = msg.role === 'user'
  return (
    <div className={'flex w-full items-end gap-2 ' + (isUser ? 'flex-row-reverse' : 'flex-row')}>
      {!isUser && (
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-600 shadow-sm">
          <Bot className="h-3.5 w-3.5 text-white" />
        </div>
      )}
      <div className={'flex max-w-[78%] flex-col gap-0.5 ' + (isUser ? 'items-end' : 'items-start')}>
        <div
          className={
            'rounded-2xl px-3 py-2 text-xs leading-relaxed shadow-sm ' +
            (isUser
              ? 'rounded-br-none bg-blue-600 text-white'
              : 'rounded-bl-none bg-slate-100 text-slate-800')
          }
        >
          {msg.content}
        </div>
        <span className="px-1 text-[10px] text-slate-400">{fmtTime(msg.ts)}</span>
      </div>
    </div>
  )
}

// ── Main ───────────────────────────────────────────────────────────────────────

export default function FloatingChatBot() {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<Message[]>([GREETING])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [unread, setUnread] = useState(0)
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Scroll to bottom on new message
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  // Focus input when panel opens
  useEffect(() => {
    if (open) {
      setUnread(0)
      setTimeout(() => inputRef.current?.focus(), 100)
    }
  }, [open])

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
        body: JSON.stringify({ message: trimmed, history }),
      })

      const data = (await res.json()) as { reply?: string; error?: string }
      if (!res.ok || data.error) throw new Error(data.error || 'Failed to get response.')

      const assistantMsg: Message = {
        id: uid(),
        role: 'assistant',
        content: data.reply ?? '(No response)',
        ts: new Date(),
      }
      setMessages((prev) => [...prev, assistantMsg])

      // Badge if panel is closed
      if (!open) setUnread((n) => n + 1)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.')
    } finally {
      setLoading(false)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void sendMessage(input)
    }
  }

  const clearChat = () => {
    setMessages([{ ...GREETING, id: uid(), ts: new Date() }])
    setError('')
    setInput('')
  }

  return (
    <>
      {/* ── Floating panel ── */}
      <div
        className={
          'fixed bottom-20 right-4 z-50 flex w-[340px] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl transition-all duration-300 ' +
          (open
            ? 'pointer-events-auto translate-y-0 opacity-100'
            : 'pointer-events-none translate-y-4 opacity-0')
        }
        style={{ maxHeight: '520px' }}
      >
        {/* Panel header */}
        <div className="flex items-center justify-between bg-blue-600 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-white/20 shadow-inner">
              <Bot className="h-4.5 w-4.5 text-white" />
            </div>
            <div>
              <p className="text-sm font-semibold text-white leading-tight">JMG Assistant</p>
              <div className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-300" />
                <span className="text-[10px] text-blue-100">AI · Always ready</span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={clearChat}
              title="Clear chat"
              className="rounded-lg p-1.5 text-blue-200 transition-colors hover:bg-white/10 hover:text-white"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => setOpen(false)}
              title="Close"
              className="rounded-lg p-1.5 text-blue-200 transition-colors hover:bg-white/10 hover:text-white"
            >
              <ChevronDown className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Messages */}
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4" style={{ minHeight: 0, maxHeight: '340px' }}>
          {messages.map((msg) => (
            <Bubble key={msg.id} msg={msg} />
          ))}
          {loading && <TypingDots />}
          <div ref={bottomRef} />
        </div>

        {/* Quick questions — only when only greeting shown */}
        {messages.length === 1 && !loading && (
          <div className="flex flex-wrap gap-1.5 border-t border-slate-100 px-4 pb-3 pt-2">
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

        {/* Error */}
        {error && (
          <div className="mx-4 mb-2 flex items-start gap-1.5 rounded-lg border border-red-100 bg-red-50 px-3 py-2">
            <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" />
            <p className="text-[11px] text-red-600">{error}</p>
          </div>
        )}

        {/* Input area */}
        <div className="border-t border-slate-100 bg-slate-50 px-4 py-3">
          <div className="flex items-end gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 transition-all focus-within:border-blue-300 focus-within:ring-2 focus-within:ring-blue-50">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKey}
              placeholder="Ask about inventory, sales, reservations…"
              rows={1}
              disabled={loading}
              className="flex-1 resize-none bg-transparent text-xs text-slate-800 outline-none placeholder:text-slate-400 disabled:opacity-50"
              style={{ maxHeight: '72px' }}
            />
            <button
              onClick={() => void sendMessage(input)}
              disabled={!input.trim() || loading}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-blue-600 text-white transition-all hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Send className="h-3.5 w-3.5" />
            </button>
          </div>
          <p className="mt-1.5 text-center text-[10px] text-slate-300">
            Enter to send · Shift+Enter for new line
          </p>
        </div>
      </div>

      {/* ── FAB trigger button ── */}
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="Open AI assistant"
        className={
          'fixed bottom-4 right-4 z-50 flex h-12 w-12 items-center justify-center rounded-full bg-blue-600 text-white shadow-lg ring-4 ring-blue-600/20 transition-all duration-300 hover:bg-blue-700 hover:shadow-xl hover:ring-blue-600/30 ' +
          (open ? 'rotate-0 scale-95' : 'rotate-0 scale-100')
        }
      >
        {open ? (
          <X className="h-5 w-5" />
        ) : (
          <>
            <Bot className="h-5 w-5" />
            {unread > 0 && (
              <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[9px] font-bold text-white">
                {unread}
              </span>
            )}
          </>
        )}
      </button>
    </>
  )
}
