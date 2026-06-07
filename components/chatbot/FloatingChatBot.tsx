'use client'

import React, { useEffect, useRef, useState } from 'react'
import { Bot, ChevronDown, Database, RotateCcw, Send, X } from 'lucide-react'

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  ts: Date
  usedLiveData?: boolean
  intent?: string
}

const uid = () => Math.random().toString(36).slice(2)
const fmtTime = (d: Date) => d.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' })

const GREETING: Message = {
  id: 'greeting',
  role: 'assistant',
  content: "Hi! I'm JMG, your AI assistant for JMGS Japan Surplus. I can pull **live data** from your store — ask me about inventory, sales, reservations, or anything else.",
  ts: new Date(),
}

const QUICK_QUESTIONS = [
  'Give me a store overview',
  "What's the trend for this month?",
  'What should we display this month?',
  'What items need restocking?',
  "What are today's sales?",
  'Which categories sell the most?',
]

const INTENT_LABELS: Record<string, string> = {
  low_stock: 'Inventory',
  inventory_summary: 'Inventory',
  today_sales: 'Sales',
  recent_sales: 'Sales',
  top_categories: 'Analytics',
  active_reservations: 'Reservations',
  stock_logs: 'Stock Logs',
  dashboard_summary: 'Dashboard',
  recommendation: 'Recommendation',
  trend: 'Trends',
}

// ── Markdown renderer ──────────────────────────────────────────────────────────

function renderInline(text: string): React.ReactNode {
  const parts: React.ReactNode[] = []
  const regex = /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`)/g
  let last = 0
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index))
    if (match[2]) parts.push(<strong key={match.index} className="font-semibold">{match[2]}</strong>)
    else if (match[3]) parts.push(<em key={match.index}>{match[3]}</em>)
    else if (match[4]) parts.push(<code key={match.index} className="rounded bg-slate-200 px-1 font-mono text-[10px]">{match[4]}</code>)
    last = match.index + match[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts.length === 1 ? parts[0] : <>{parts}</>
}

function renderMarkdown(text: string): React.ReactNode[] {
  const lines = text.split('\n')
  const result: React.ReactNode[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') { result.push(<div key={`gap-${i}`} className="h-1" />); i++; continue }
    if (/^#{1,3}\s/.test(line)) {
      result.push(<p key={i} className="font-semibold text-slate-800 text-xs mt-1">{renderInline(line.replace(/^#{1,3}\s/, ''))}</p>)
      i++; continue
    }
    if (/^[-*]\s/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^[-*]\s/.test(lines[i])) { items.push(lines[i].replace(/^[-*]\s/, '')); i++ }
      result.push(
        <ul key={`ul-${i}`} className="space-y-0.5 pl-3">
          {items.map((item, idx) => (
            <li key={idx} className="flex gap-1.5 text-xs">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-slate-400" />
              <span>{renderInline(item)}</span>
            </li>
          ))}
        </ul>
      )
      continue
    }
    if (/^\d+\.\s/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) { items.push(lines[i].replace(/^\d+\.\s/, '')); i++ }
      result.push(
        <ol key={`ol-${i}`} className="space-y-0.5 pl-3">
          {items.map((item, idx) => (
            <li key={idx} className="flex gap-1.5 text-xs">
              <span className="shrink-0 font-medium text-slate-500">{idx + 1}.</span>
              <span>{renderInline(item)}</span>
            </li>
          ))}
        </ol>
      )
      continue
    }
    result.push(<p key={i} className="text-xs leading-relaxed">{renderInline(line)}</p>)
    i++
  }
  return result
}

// ── Typing indicator ───────────────────────────────────────────────────────────

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

// ── Message bubble ─────────────────────────────────────────────────────────────

function Bubble({ msg }: { msg: Message }) {
  const isUser = msg.role === 'user'
  const intentLabel = msg.intent ? INTENT_LABELS[msg.intent] : undefined
  return (
    <div className={'flex w-full items-end gap-2 ' + (isUser ? 'flex-row-reverse' : 'flex-row')}>
      {!isUser && (
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-600 shadow-sm">
          <Bot className="h-3.5 w-3.5 text-white" />
        </div>
      )}
      <div className={'flex max-w-[80%] flex-col gap-1 ' + (isUser ? 'items-end' : 'items-start')}>
        {!isUser && msg.usedLiveData && intentLabel && (
          <div className="flex items-center gap-1 rounded-full border border-emerald-100 bg-emerald-50 px-2 py-0.5">
            <Database className="h-2.5 w-2.5 text-emerald-500" />
            <span className="text-[10px] font-medium text-emerald-600">Live · {intentLabel}</span>
          </div>
        )}
        <div className={'rounded-2xl px-3 py-2 shadow-sm ' + (isUser ? 'rounded-br-none bg-blue-600 text-white' : 'rounded-bl-none bg-slate-100 text-slate-800')}>
          {isUser
            ? <p className="text-xs leading-relaxed">{msg.content}</p>
            : <div className="space-y-1">{renderMarkdown(msg.content)}</div>
          }
        </div>
        <span suppressHydrationWarning className="px-1 text-[10px] text-slate-400">{fmtTime(msg.ts)}</span>
      </div>
    </div>
  )
}

// ── Main Component ─────────────────────────────────────────────────────────────

export default function FloatingChatBot() {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<Message[]>([GREETING])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [unread, setUnread] = useState(0)
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Set to true to show placeholder while under development
  const COMING_SOON = false

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, loading])
  useEffect(() => { if (open) { setTimeout(() => inputRef.current?.focus(), 100) } }, [open])

  if (COMING_SOON) {
    return (
      <>
        {/* Panel */}
        <div
          className={'fixed bottom-20 right-4 z-50 w-[340px] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl transition-all duration-300 ' + (open ? 'pointer-events-auto translate-y-0 opacity-100' : 'pointer-events-none translate-y-4 opacity-0')}
        >
          {/* Header */}
          <div className="flex items-center justify-between bg-blue-600 px-4 py-3">
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-white/20">
                <Bot className="h-4 w-4 text-white" />
              </div>
              <div>
                <p className="text-sm font-semibold text-white">JMG Assistant</p>
              </div>
            </div>
            <button onClick={() => setOpen(false)} className="rounded-lg p-1.5 text-blue-200 hover:bg-white/10 hover:text-white">
              <ChevronDown className="h-4 w-4" />
            </button>
          </div>

          {/* Empty message area */}
          <div style={{ minHeight: '260px' }} />

          {/* Disabled input */}
          <div className="border-t border-slate-100 bg-slate-50 px-4 py-3">
            <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 opacity-50">
              <p className="flex-1 text-xs text-slate-400 select-none">Ask about inventory, sales, reservations…</p>
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-blue-600 opacity-40">
                <Send className="h-3.5 w-3.5 text-white" />
              </div>
            </div>
            <p className="mt-1.5 text-center text-[10px] text-slate-300">Powered by Gemini · Enter to send</p>
          </div>
        </div>

        {/* FAB */}
        <button
          onClick={() => setOpen((v) => !v)}
          className={'fixed bottom-4 right-4 z-50 flex h-12 w-12 items-center justify-center rounded-full bg-blue-600 text-white shadow-lg ring-4 ring-blue-600/20 transition-all duration-300 hover:bg-blue-700 ' + (open ? 'scale-95' : 'scale-100')}
        >
          {open ? <X className="h-5 w-5" /> : <Bot className="h-5 w-5" />}
        </button>
      </>
    )
  }

  // ── Full chat (enabled when COMING_SOON = false) ───────────────────────────

  const sendMessage = async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed || loading) return
    setMessages((prev) => [...prev, { id: uid(), role: 'user', content: trimmed, ts: new Date() }])
    setInput('')
    setError('')
    setLoading(true)
    try {
      const history = messages.slice(-6).map((m) => ({ role: m.role, content: m.content }))
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: trimmed, history }),
      })
      const data = (await res.json()) as { reply?: string; error?: string; usedLiveData?: boolean; usedTool?: string }
      if (!res.ok || data.error) {
        const isBusy = res.status === 429 || (data.error ?? '').toLowerCase().includes('busy')
        throw new Error(isBusy ? 'busy' : 'unavailable')
      }
      setMessages((prev) => [...prev, { id: uid(), role: 'assistant', content: data.reply ?? '(No response)', ts: new Date(), usedLiveData: data.usedLiveData, intent: data.usedTool ?? undefined }])
      if (!open) setUnread((n) => n + 1)
    } catch (e) {
      const msg = e instanceof Error ? e.message : ''
      setError(
        msg === 'busy'
          ? 'The assistant is a bit busy right now. Please wait a moment and try again.'
          : 'The assistant is not currently available. Please try again later.'
      )
    } finally {
      setLoading(false)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendMessage(input) }
  }

  const clearChat = () => {
    setMessages([{ ...GREETING, id: uid(), ts: new Date() }])
    setError('')
  }

  return (
    <>
      <div
        className={'fixed bottom-20 right-4 z-50 flex w-[360px] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl transition-all duration-300 ' + (open ? 'pointer-events-auto translate-y-0 opacity-100' : 'pointer-events-none translate-y-4 opacity-0')}
        style={{ maxHeight: '540px' }}
      >
        <div className="flex items-center justify-between bg-blue-600 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-white/20 shadow-inner">
              <Bot className="h-4 w-4 text-white" />
            </div>
            <div>
              <p className="text-sm font-semibold text-white leading-tight">JMG Assistant</p>
              <div className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-300" />
                <span className="text-[10px] text-blue-100">Hybrid AI · Live data</span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={clearChat} title="Clear chat" className="rounded-lg p-1.5 text-blue-200 transition-colors hover:bg-white/10 hover:text-white">
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
            <button onClick={() => setOpen(false)} className="rounded-lg p-1.5 text-blue-200 transition-colors hover:bg-white/10 hover:text-white">
              <ChevronDown className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4" style={{ minHeight: 0, maxHeight: '360px' }}>
          {messages.map((msg) => <Bubble key={msg.id} msg={msg} />)}
          {loading && <TypingDots />}
          <div ref={bottomRef} />
        </div>
        {messages.length === 1 && !loading && (
          <div className="flex flex-wrap gap-1.5 border-t border-slate-100 px-4 pb-3 pt-2">
            {QUICK_QUESTIONS.map((q) => (
              <button key={q} onClick={() => void sendMessage(q)} className="rounded-full border border-blue-100 bg-blue-50 px-2.5 py-1 text-[11px] font-medium text-blue-600 transition-colors hover:bg-blue-100">
                {q}
              </button>
            ))}
          </div>
        )}
        {error && (
          <div className="mx-4 mb-2 flex items-start gap-1.5 rounded-lg border border-red-100 bg-red-50 px-3 py-2">
            <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" />
            <p className="text-[11px] text-red-600">{error}</p>
          </div>
        )}
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
          <p className="mt-1.5 text-center text-[10px] text-slate-300">Enter to send · Shift+Enter for new line</p>
        </div>
      </div>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="Open AI assistant"
        className={'fixed bottom-4 right-4 z-50 flex h-12 w-12 items-center justify-center rounded-full bg-blue-600 text-white shadow-lg ring-4 ring-blue-600/20 transition-all duration-300 hover:bg-blue-700 hover:shadow-xl ' + (open ? 'scale-95' : 'scale-100')}
      >
        {open ? <X className="h-5 w-5" /> : (
          <div className="relative">
            <Bot className="h-5 w-5" />
            {unread > 0 && <span className="absolute -right-2.5 -top-2.5 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[9px] font-bold text-white">{unread > 9 ? '9+' : unread}</span>}
          </div>
        )}
      </button>
    </>
  )
}
