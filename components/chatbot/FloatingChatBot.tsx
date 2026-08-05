'use client'

// The floating chat bubble in the corner of every dashboard page.
// Handles open/close and positioning; the conversation itself lives in ChatBot.

import React, { useEffect, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import { useUserRole } from '@/hooks/useUserRole'
import { ChevronDown, Database, RotateCcw, Send, Sparkles, ThumbsDown, ThumbsUp, X } from 'lucide-react'

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  ts: Date
  usedLiveData?: boolean
  intent?: string
  feedback?: 'up' | 'down' | null
}

const uid = () => Math.random().toString(36).slice(2)
const fmtTime = (d: Date) => d.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' })

const GREETING: Message = {
  id: 'greeting',
  role: 'assistant',
  content: "Hi! I'm **JMG**, your AI store assistant for JMGS Japan Surplus.\n\nI have access to **live store data** — ask me about inventory, sales, reservations, predictions, or anything about the store.",
  ts: new Date(),
}

const QUICK_QUESTIONS = [
  '📊 Store overview',
  '📦 Low stock items',
  "💰 Today's sales",
  '📈 Sales trend',
  '🔮 Predict next week',
  '🌟 What to promote?',
]

const INTENT_LABELS: Record<string, string> = {
  getLowStockItems:       'Inventory',
  getOutOfStockItems:     'Inventory',
  getInventorySummary:    'Inventory',
  getStockAging:          'Inventory',
  searchInventory:        'Inventory',
  getInventoryByCategory: 'Inventory',
  getTodaySales:          'Sales',
  getRecentSales:         'Sales',
  getTopCategories:       'Analytics',
  getTrendData:           'Trends',
  getFrequentCustomers:   'Customers',
  getBasketAnalysis:      'Analytics',
  getDashboardSummary:    'Dashboard',
  getRecommendations:     'Recommend',
  getActiveReservations:  'Reservations',
  getOverdueReservations: 'Reservations',
  getPendingReservations: 'Reservations',
  getAllCustomers:         'Customers',
  getCustomerHistory:     'Customers',
  getAllShipments:         'Shipments',
  getActiveShipments:     'Shipments',
  getDeliveredShipments:  'Shipments',
  getPendingShipments:    'Shipments',
  getStockLogs:           'Stock Logs',
  predictSales:           'Prediction',
}

const STORAGE_KEY = 'jmg_chat_history'

// ── Custom AI Logo ─────────────────────────────────────────────────────────────

function JMGLogo({ size = 20, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
      <path d="M12 2L13.8 8.2L20 10L13.8 11.8L12 18L10.2 11.8L4 10L10.2 8.2L12 2Z" fill="currentColor" opacity="0.9"/>
      <path d="M19 16L19.9 18.1L22 19L19.9 19.9L19 22L18.1 19.9L16 19L18.1 18.1L19 16Z" fill="currentColor" opacity="0.6"/>
      <path d="M5 3L5.6 4.4L7 5L5.6 5.6L5 7L4.4 5.6L3 5L4.4 4.4L5 3Z" fill="currentColor" opacity="0.5"/>
    </svg>
  )
}

// ── Markdown renderer ──────────────────────────────────────────────────────────

function renderInline(text: string): React.ReactNode {
  const parts: React.ReactNode[] = []
  const regex = /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`)/g
  let last = 0
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index))
    if (match[2]) parts.push(<strong key={match.index} className="font-semibold text-slate-900">{match[2]}</strong>)
    else if (match[3]) parts.push(<em key={match.index}>{match[3]}</em>)
    else if (match[4]) parts.push(<code key={match.index} className="rounded-md bg-slate-200/80 px-1.5 py-0.5 font-mono text-[10px] text-slate-700">{match[4]}</code>)
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
    if (line.trim() === '') { result.push(<div key={`gap-${i}`} className="h-1.5" />); i++; continue }
    if (/^#{1,3}\s/.test(line)) {
      result.push(<p key={i} className="font-semibold text-slate-800 text-xs mt-1.5">{renderInline(line.replace(/^#{1,3}\s/, ''))}</p>)
      i++; continue
    }
    if (/^[-*]\s/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^[-*]\s/.test(lines[i])) { items.push(lines[i].replace(/^[-*]\s/, '')); i++ }
      result.push(
        <ul key={`ul-${i}`} className="space-y-1 pl-1 mt-0.5">
          {items.map((item, idx) => (
            <li key={idx} className="flex gap-2 text-xs leading-relaxed">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-teal-500" />
              <span className="text-slate-700">{renderInline(item)}</span>
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
        <ol key={`ol-${i}`} className="space-y-1 pl-1 mt-0.5">
          {items.map((item, idx) => (
            <li key={idx} className="flex gap-2 text-xs leading-relaxed">
              <span className="shrink-0 font-semibold text-teal-600 min-w-3.5">{idx + 1}.</span>
              <span className="text-slate-700">{renderInline(item)}</span>
            </li>
          ))}
        </ol>
      )
      continue
    }
    result.push(<p key={i} className="text-xs leading-relaxed text-slate-700">{renderInline(line)}</p>)
    i++
  }
  return result
}

// ── Typing indicator ───────────────────────────────────────────────────────────

function TypingDots() {
  return (
    <div className="flex items-end gap-2.5">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-linear-to-br from-[#1E3A5F] to-[#0D9A8A] shadow-md">
        <JMGLogo size={14} className="text-white" />
      </div>
      <div className="flex items-center gap-1.5 rounded-2xl rounded-bl-sm bg-white border border-slate-100 px-4 py-3 shadow-sm">
        <span className="h-2 w-2 animate-bounce rounded-full bg-teal-400 [animation-delay:0ms]" />
        <span className="h-2 w-2 animate-bounce rounded-full bg-teal-400 [animation-delay:150ms]" />
        <span className="h-2 w-2 animate-bounce rounded-full bg-teal-400 [animation-delay:300ms]" />
      </div>
    </div>
  )
}

// ── Message bubble ─────────────────────────────────────────────────────────────

function Bubble({ msg, onFeedback }: { msg: Message; onFeedback?: (id: string, fb: 'up' | 'down') => void }) {
  const isUser = msg.role === 'user'
  const intentLabel = msg.intent ? INTENT_LABELS[msg.intent] : undefined
  return (
    <div className={'flex w-full items-end gap-2.5 ' + (isUser ? 'flex-row-reverse' : 'flex-row')}>
      {/* Bot avatar */}
      {!isUser && (
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-linear-to-br from-[#1E3A5F] to-[#0D9A8A] shadow-md">
          <JMGLogo size={14} className="text-white" />
        </div>
      )}
      <div className={'flex max-w-[82%] flex-col gap-1 ' + (isUser ? 'items-end' : 'items-start')}>
        {/* Live data badge */}
        {!isUser && msg.usedLiveData && intentLabel && (
          <div className="flex items-center gap-1 rounded-full border border-teal-100 bg-teal-50 px-2.5 py-0.5 shadow-sm">
            <Database className="h-2.5 w-2.5 text-teal-500" />
            <span className="text-[10px] font-semibold text-teal-600 tracking-wide uppercase">{intentLabel}</span>
            <span className="h-1.5 w-1.5 rounded-full bg-teal-400 animate-pulse ml-0.5" />
          </div>
        )}
        {/* Bubble */}
        <div className={
          'rounded-2xl px-3.5 py-2.5 shadow-sm ' +
          (isUser
            ? 'rounded-br-sm bg-linear-to-br from-[#1E3A5F] to-[#0f4c81] text-white'
            : 'rounded-bl-sm bg-white border border-slate-100 text-slate-800')
        }>
          {isUser
            ? <p className="text-xs leading-relaxed">{msg.content}</p>
            : <div className="space-y-1">{renderMarkdown(msg.content)}</div>
          }
        </div>
        {/* Timestamp + feedback */}
        <div className={'flex items-center gap-1.5 px-1 ' + (isUser ? 'flex-row-reverse' : 'flex-row')}>
          <span suppressHydrationWarning className="text-[10px] text-slate-400">{fmtTime(msg.ts)}</span>
          {!isUser && onFeedback && msg.id !== 'greeting' && (
            <div className="flex items-center gap-0.5">
              <button
                onClick={() => onFeedback(msg.id, 'up')}
                className={`rounded p-0.5 transition-colors ${msg.feedback === 'up' ? 'text-teal-500' : 'text-slate-300 hover:text-teal-400'}`}
                title="Helpful"
              >
                <ThumbsUp className="h-3 w-3" />
              </button>
              <button
                onClick={() => onFeedback(msg.id, 'down')}
                className={`rounded p-0.5 transition-colors ${msg.feedback === 'down' ? 'text-red-400' : 'text-slate-300 hover:text-red-400'}`}
                title="Not helpful"
              >
                <ThumbsDown className="h-3 w-3" />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Main Component ─────────────────────────────────────────────────────────────

export default function FloatingChatBot() {
  const pathname = usePathname()
  const { role: userRole } = useUserRole()
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<Message[]>([GREETING])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [unread, setUnread] = useState(0)
  const [hydrated, setHydrated] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  const COMING_SOON = false

  // Derive friendly page name from pathname
  const currentPage = (() => {
    if (!pathname) return undefined
    const parts = pathname.split('/').filter(Boolean)
    const last = parts[parts.length - 1]
    const map: Record<string, string> = {
      dashboard: 'Dashboard', inventory: 'Inventory', sales: 'Sales',
      reservations: 'Reservations', analytics: 'Analytics', customers: 'Customers',
      containers: 'Shipments', users: 'Users', logs: 'Stock Logs', trash: 'Trash',
    }
    return map[last] ?? last
  })()

  // Load persisted chat from localStorage (client-side only)
  useEffect(() => {
    setHydrated(true)
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) {
        const parsed = JSON.parse(saved) as Array<Omit<Message, 'ts'> & { ts: string }>
        const restored = parsed.map(m => ({ ...m, ts: new Date(m.ts) }))
        if (restored.length > 0) setMessages(restored)
      }
    } catch { /* ignore parse errors */ }
  }, [])

  // Persist chat to localStorage on every change (skip until hydrated)
  useEffect(() => {
    if (!hydrated) return
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(messages)) } catch { /* ignore */ }
  }, [messages, hydrated])

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, loading])
  useEffect(() => { if (open) { setUnread(0); setTimeout(() => inputRef.current?.focus(), 100) } }, [open])

  // ── COMING SOON mode ────────────────────────────────────────────────────────

  if (COMING_SOON) {
    return (
      <>
        <div className={'fixed bottom-20 right-4 z-50 w-[380px] overflow-hidden rounded-2xl border border-slate-200/60 bg-white shadow-2xl transition-all duration-300 ' + (open ? 'pointer-events-auto translate-y-0 opacity-100' : 'pointer-events-none translate-y-4 opacity-0')}>
          <ChatHeader onClose={() => setOpen(false)} onClear={() => {}} />
          <div style={{ minHeight: '280px' }} />
          <ChatFooterDisabled />
        </div>
        <FAB open={open} unread={unread} onClick={() => setOpen(v => !v)} />
      </>
    )
  }

  // ── Send message ─────────────────────────────────────────────────────────────

  const cancelRequest = () => {
    abortRef.current?.abort()
    abortRef.current = null
    setLoading(false)
    setError('')
    setTimeout(() => inputRef.current?.focus(), 50)
  }

  const sendMessage = async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed || loading) return
    setMessages(prev => [...prev, { id: uid(), role: 'user', content: trimmed, ts: new Date() }])
    setInput('')
    setError('')
    setLoading(true)
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const history = messages.slice(-6).map(m => ({ role: m.role, content: m.content }))
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: trimmed, history, page: currentPage, role: userRole }),
        signal: controller.signal,
      })
      const data = (await res.json()) as { reply?: string; error?: string; usedLiveData?: boolean; usedTool?: string }
      if (!res.ok || data.error) {
        const isBusy = res.status === 429 || (data.error ?? '').toLowerCase().includes('busy')
        throw new Error(isBusy ? 'busy' : 'unavailable')
      }
      setMessages(prev => [...prev, {
        id: uid(), role: 'assistant',
        content: data.reply ?? '(No response)',
        ts: new Date(),
        usedLiveData: data.usedLiveData,
        intent: data.usedTool ?? undefined,
      }])
      if (!open) setUnread(n => n + 1)
    } catch (e) {
      const msg = e instanceof Error ? e.message : ''
      if (msg === 'The user aborted a request.' || msg.includes('abort') || (e instanceof Error && e.name === 'AbortError')) return
      setError(
        msg === 'busy'
          ? 'The assistant is a bit busy right now. Please wait a moment and try again.'
          : 'The assistant is not currently available. Please try again later.'
      )
    } finally {
      abortRef.current = null
      setLoading(false)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendMessage(input) }
  }

  const clearChat = () => {
    const fresh = [{ ...GREETING, id: uid(), ts: new Date() }]
    setMessages(fresh)
    setError('')
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(fresh)) } catch { /* ignore */ }
  }

  const handleFeedback = (id: string, fb: 'up' | 'down') => {
    setMessages(prev => prev.map(m => m.id === id ? { ...m, feedback: m.feedback === fb ? null : fb } : m))
  }

  return (
    <>
      {/* ── Chat panel ── */}
      <div
        className={
          'fixed bottom-[76px] right-4 z-50 flex w-[380px] flex-col overflow-hidden rounded-2xl border border-slate-200/60 bg-[#f8fafc] shadow-2xl shadow-slate-900/20 transition-all duration-300 ' +
          (open ? 'pointer-events-auto translate-y-0 opacity-100 scale-100' : 'pointer-events-none translate-y-6 opacity-0 scale-95')
        }
        style={{ maxHeight: '580px' }}
      >
        {/* Header */}
        <ChatHeader onClose={() => setOpen(false)} onClear={clearChat} page={currentPage} />

        {/* Messages */}
        <div className="flex flex-1 flex-col gap-3.5 overflow-y-auto px-4 py-4" style={{ minHeight: 0, maxHeight: '380px' }}>
          {messages.map(msg => <Bubble key={msg.id} msg={msg} onFeedback={handleFeedback} />)}
          {loading && <TypingDots />}
          <div ref={bottomRef} />
        </div>

        {/* Quick questions (only on fresh chat) */}
        {messages.length === 1 && !loading && (
          <div className="border-t border-slate-100 bg-white px-4 pb-3 pt-3">
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400">Quick questions</p>
            <div className="flex flex-wrap gap-1.5">
              {QUICK_QUESTIONS.map(q => (
                <button
                  key={q}
                  onClick={() => void sendMessage(q.replace(/^[^\s]+\s/, ''))}
                  className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-[11px] font-medium text-slate-600 transition-all hover:border-teal-200 hover:bg-teal-50 hover:text-teal-700 active:scale-95"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Error banner */}
        {error && (
          <div className="mx-4 mb-2 flex items-start gap-2 rounded-xl border border-red-100 bg-red-50 px-3 py-2.5">
            <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" />
            <p className="text-[11px] leading-relaxed text-red-600">{error}</p>
          </div>
        )}

        {/* Input area */}
        <div className="border-t border-slate-100 bg-white px-4 py-3">
          <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-0 transition-all focus-within:border-teal-300 focus-within:bg-white focus-within:ring-2 focus-within:ring-teal-50" style={{ minHeight: '40px' }}>
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKey}
              placeholder="Ask about inventory, sales, predictions…"
              rows={1}
              disabled={loading}
              className="flex-1 resize-none bg-transparent py-2.5 text-xs leading-tight text-slate-800 outline-none placeholder:text-slate-400 disabled:opacity-50"
              style={{ maxHeight: '80px' }}
            />
            {/* Clear input button — shown when typing and not loading */}
            {input.trim() && !loading && (
              <button
                onClick={() => { setInput(''); inputRef.current?.focus() }}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-slate-400 transition-all hover:bg-slate-200 hover:text-slate-600"
                title="Clear"
              >
                <X className="h-3 w-3" />
              </button>
            )}
            {/* Send button OR Cancel button when loading */}
            {loading ? (
              <button
                onClick={cancelRequest}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-red-500 text-white shadow-sm transition-all hover:bg-red-600 hover:scale-105"
                title="Cancel"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : (
              <button
                onClick={() => void sendMessage(input)}
                disabled={!input.trim()}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-linear-to-br from-[#1E3A5F] to-[#0D9A8A] text-white shadow-sm transition-all hover:shadow-md hover:scale-105 disabled:cursor-not-allowed disabled:opacity-30 disabled:scale-100"
                title="Send"
              >
                <Send className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <div className="mt-1.5 flex items-center justify-center gap-1.5">
            <Sparkles className="h-2.5 w-2.5 text-slate-300" />
            <p className="text-center text-[10px] text-slate-300">Press Enter to send</p>
          </div>
        </div>
      </div>

      {/* ── FAB ── */}
      <FAB open={open} unread={unread} onClick={() => setOpen(v => !v)} />
    </>
  )
}

// ── Chat Header ───────────────────────────────────────────────────────────────

function ChatHeader({ onClose, onClear, page }: { onClose: () => void; onClear: () => void; page?: string }) {
  return (
    <div className="relative flex items-center justify-between overflow-hidden px-4 py-3.5"
      style={{ background: 'linear-gradient(135deg, #1E3A5F 0%, #0f4c81 50%, #0D9A8A 100%)' }}>
      {/* Background sparkle decoration */}
      <div className="absolute inset-0 opacity-10">
        <div className="absolute right-6 top-1 h-8 w-8 rounded-full bg-white/30 blur-xl" />
        <div className="absolute right-16 bottom-0 h-6 w-6 rounded-full bg-teal-300 blur-lg" />
      </div>
      {/* Left: logo + name */}
      <div className="relative flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/15 shadow-inner backdrop-blur-sm border border-white/20">
          <JMGLogo size={18} className="text-white" />
        </div>
        <div>
          <p className="text-sm font-bold text-white leading-tight tracking-wide">JMG Assistant</p>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-300 animate-pulse" />
            <span className="text-[10px] text-white/70 font-medium">
              AI · Live data{page ? ` · ${page}` : ''}
            </span>
          </div>
        </div>
      </div>
      {/* Right: actions */}
      <div className="relative flex items-center gap-0.5">
        <button onClick={onClear} title="Clear chat"
          className="rounded-lg p-2 text-white/60 transition-colors hover:bg-white/15 hover:text-white">
          <RotateCcw className="h-4 w-4" />
        </button>
        <button onClick={onClose}
          className="rounded-lg p-2 text-white/60 transition-colors hover:bg-white/15 hover:text-white">
          <ChevronDown className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}

// ── Disabled footer (coming soon mode) ────────────────────────────────────────

function ChatFooterDisabled() {
  return (
    <div className="border-t border-slate-100 bg-white px-4 py-3">
      <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 opacity-50 cursor-not-allowed">
        <p className="flex-1 text-xs text-slate-400 select-none">Ask about inventory, sales, predictions…</p>
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-linear-to-br from-[#1E3A5F] to-[#0D9A8A] opacity-40">
          <Send className="h-3.5 w-3.5 text-white" />
        </div>
      </div>
      <div className="mt-1.5 flex items-center justify-center gap-1.5">
        <Sparkles className="h-2.5 w-2.5 text-slate-300" />
        <p className="text-center text-[10px] text-slate-300">Powered by OpenAI</p>
      </div>
    </div>
  )
}

// FAB (Floating Action Button)
function FAB({ open, unread, onClick }: { open: boolean; unread: number; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-label="Open AI assistant"
      className={
        'fixed bottom-5 right-4 z-50 flex h-14 w-14 items-center justify-center rounded-2xl text-white shadow-lg transition-all duration-300 hover:shadow-xl active:scale-95 ' +
        (open ? 'scale-95' : 'scale-100')
      }
      style={{
        background: open
          ? 'linear-gradient(135deg, #374151, #1f2937)'
          : 'linear-gradient(135deg, #1E3A5F 0%, #0D9A8A 100%)',
        boxShadow: open
          ? '0 4px 20px rgba(0,0,0,0.3)'
          : '0 4px 24px rgba(13,154,138,0.4), 0 2px 8px rgba(30,58,95,0.3)',
      }}
    >
      {open ? (
        <X className="h-5 w-5" />
      ) : (
        <div className="relative flex items-center justify-center">
          <JMGLogo size={22} className="text-white" />
          <span
            className="absolute inset-0 rounded-2xl animate-ping opacity-20 bg-teal-400"
            style={{ animationDuration: '2.5s' }}
          />
          {unread > 0 && (
            <span className="absolute -top-1.5 -right-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[9px] font-bold text-white shadow">
              {unread > 9 ? '9+' : unread}
            </span>
          )}
        </div>
      )}
    </button>
  )
}
