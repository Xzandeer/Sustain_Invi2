'use client'

// Customers page - everyone who has bought or reserved, built from the
// customer details captured on sales and reservations.
//
// There is no separate customer database. Walk-in sales have no name attached,
// so they do not appear here.

import { useEffect, useMemo, useState } from 'react'
import { collection, getDocs } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import ProtectedRoute from '@/components/shared/ProtectedRoute'
import { toDate, toNumber } from '@/lib/server/salesInventoryMetrics'
import {
  ChevronDown, ChevronUp, Mail, Phone, Search,
  ShoppingCart, Calendar, UserCheck, Receipt,
} from 'lucide-react'

// ── Types ─────────────────────────────────────────────────────────────────────

interface SaleDoc {
  id: string
  transactionNumber?: string
  customer?: string
  customerEmail?: string
  customerContactNumber?: string
  totalAmount?: number
  items?: Array<{ name?: string; quantity?: number; price?: number }>
  createdAt?: unknown
}

interface ReservationDoc {
  id: string
  reservationNumber?: string
  customer?: string
  customerEmail?: string
  customerContactNumber?: string
  customerDetails?: { fullName?: string; email?: string; contactNumber?: string }
  items?: Array<{ name?: string; quantity?: number; price?: number }>
  status?: string
  createdAt?: unknown
}

interface Transaction {
  id: string
  type: 'sale' | 'reservation'
  number: string
  amount: number
  items: Array<{ name: string; quantity: number }>
  status?: string
  date: Date | null
}

interface Customer {
  email: string
  name: string
  contact: string
  totalSpent: number
  transactions: Transaction[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const fmt = (n: number) =>
  `₱${n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const fmtDate = (d: Date | null) =>
  d ? d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'

const statusColor: Record<string, string> = {
  Active:    'bg-blue-100 text-blue-700',
  Completed: 'bg-emerald-100 text-emerald-700',
  Cancelled: 'bg-red-100 text-red-700',
  Expired:   'bg-slate-100 text-slate-600',
  Sale:      'bg-violet-100 text-violet-700',
}

// ── Page wrapper ──────────────────────────────────────────────────────────────

export default function CustomersPage() {
  return (
    <ProtectedRoute>
      <CustomersContent />
    </ProtectedRoute>
  )
}

// ── Main content ──────────────────────────────────────────────────────────────

function CustomersContent() {
  const [sales, setSales]             = useState<SaleDoc[]>([])
  const [reservations, setReservations] = useState<ReservationDoc[]>([])
  const [loading, setLoading]         = useState(true)
  const [search, setSearch]           = useState('')
  const [expanded, setExpanded]       = useState<string | null>(null)

  // One-time fetch (not real-time — customer list doesn't need live updates)
  useEffect(() => {
    let cancelled = false
    async function loadData() {
      try {
        const [salesSnap, resSnap] = await Promise.all([
          getDocs(collection(db, 'sales')),
          getDocs(collection(db, 'reservations')),
        ])
        if (cancelled) return
        setSales(salesSnap.docs.map((d) => ({ id: d.id, ...d.data() } as SaleDoc)))
        setReservations(resSnap.docs.map((d) => ({ id: d.id, ...d.data() } as ReservationDoc)))
        setLoading(false)
      } catch (_) { setLoading(false) }
    }
    loadData()
    return () => { cancelled = true }
  }, [])

  // Build customer map keyed by normalised email
  const customers = useMemo<Customer[]>(() => {
    const map = new Map<string, Customer>()

    const upsert = (email: string, name: string, contact: string, tx: Transaction) => {
      const key = email.toLowerCase().trim() || `anon-${name.toLowerCase().trim()}`
      if (!map.has(key)) {
        map.set(key, { email, name, contact, totalSpent: 0, transactions: [] })
      }
      const c = map.get(key)!
      // Keep the most complete name/contact
      if (name && !c.name) c.name = name
      if (contact && !c.contact) c.contact = contact
      c.totalSpent += tx.amount
      c.transactions.push(tx)
    }

    sales.forEach((s) => {
      const email   = s.customerEmail?.trim() ?? ''
      const name    = s.customer?.trim() ?? ''
      const contact = s.customerContactNumber?.trim() ?? ''
      upsert(email, name, contact, {
        id: s.id,
        type: 'sale',
        number: s.transactionNumber ?? s.id.slice(0, 8),
        amount: toNumber(s.totalAmount),
        items: (s.items ?? []).map((i) => ({ name: i.name ?? 'Item', quantity: toNumber(i.quantity, 1) })),
        status: 'Sale',
        date: toDate(s.createdAt),
      })
    })

    reservations.forEach((r) => {
      const cd      = r.customerDetails
      const email   = (cd?.email ?? r.customerEmail ?? '').trim()
      const name    = (cd?.fullName ?? r.customer ?? '').trim()
      const contact = (cd?.contactNumber ?? r.customerContactNumber ?? '').trim()
      const amount  = (r.items ?? []).reduce((sum, i) => sum + toNumber(i.price) * toNumber(i.quantity, 1), 0)
      upsert(email, name, contact, {
        id: r.id,
        type: 'reservation',
        number: r.reservationNumber ?? r.id.slice(0, 8),
        amount,
        items: (r.items ?? []).map((i) => ({ name: i.name ?? 'Item', quantity: toNumber(i.quantity, 1) })),
        status: r.status ?? 'Active',
        date: toDate(r.createdAt),
      })
    })

    return Array.from(map.values())
      .filter((c) => c.name || c.email)
      .sort((a, b) => b.totalSpent - a.totalSpent)
  }, [sales, reservations])

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim()
    if (!q) return customers
    return customers.filter((c) =>
      c.name.toLowerCase().includes(q) ||
      c.email.toLowerCase().includes(q) ||
      c.contact.includes(q)
    )
  }, [customers, search])

  const toggle = (email: string) =>
    setExpanded((prev) => (prev === email ? null : email))

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
      </div>
    )
  }

  return (
    <div className="space-y-5 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Customers</h1>
          <p className="text-sm text-slate-500">
            {customers.length} unique customer{customers.length !== 1 ? 's' : ''} from sales &amp; reservations
          </p>
        </div>
        <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 shadow-sm focus-within:border-blue-300 focus-within:ring-2 focus-within:ring-blue-50">
          <Search className="h-4 w-4 text-slate-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, email, or contact..."
            className="w-64 bg-transparent text-sm text-slate-700 outline-none placeholder:text-slate-400"
          />
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4">
        {[
          {
            label: 'Total Customers',
            value: customers.length,
            icon: UserCheck,
            color: 'text-blue-600',
            bg: 'bg-blue-50',
          },
          {
            label: 'Total Sales Transactions',
            value: sales.length,
            icon: ShoppingCart,
            color: 'text-violet-600',
            bg: 'bg-violet-50',
          },
          {
            label: 'Total Reservations',
            value: reservations.length,
            icon: Calendar,
            color: 'text-emerald-600',
            bg: 'bg-emerald-50',
          },
        ].map(({ label, value, icon: Icon, color, bg }) => (
          <div key={label} className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${bg}`}>
              <Icon className={`h-5 w-5 ${color}`} />
            </div>
            <div>
              <p className="text-xs text-slate-500">{label}</p>
              <p className="text-xl font-bold text-slate-900">{value}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        {/* Table header */}
        <div className="grid grid-cols-[2fr_2fr_1.5fr_1fr_1fr_1fr] gap-4 border-b border-slate-100 bg-slate-50 px-5 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
          <span>Customer</span>
          <span>Email</span>
          <span>Contact</span>
          <span>Transactions</span>
          <span>Total Spent</span>
          <span />
        </div>

        {filtered.length === 0 && (
          <div className="py-16 text-center text-sm text-slate-400">
            {search ? 'No customers match your search.' : 'No customer data yet.'}
          </div>
        )}

        {filtered.map((c) => {
          const isOpen = expanded === (c.email || c.name)
          const key    = c.email || c.name
          const lastTx = c.transactions.sort((a, b) =>
            (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0)
          )[0]

          return (
            <div key={key} className="border-b border-slate-100 last:border-0">
              {/* Row */}
              <div
                className="grid cursor-pointer grid-cols-[2fr_2fr_1.5fr_1fr_1fr_1fr] items-center gap-4 px-5 py-3.5 transition-colors hover:bg-slate-50"
                onClick={() => toggle(key)}
              >
                {/* Name + last seen */}
                <div>
                  <p className="text-sm font-medium text-slate-800">{c.name || '—'}</p>
                  <p className="text-xs text-slate-400">
                    Last: {fmtDate(lastTx?.date ?? null)}
                  </p>
                </div>

                {/* Email */}
                <div className="flex items-center gap-1.5 truncate">
                  {c.email ? (
                    <>
                      <Mail className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                      <span className="truncate text-sm text-slate-600">{c.email}</span>
                    </>
                  ) : (
                    <span className="text-sm text-slate-400">—</span>
                  )}
                </div>

                {/* Contact */}
                <div className="flex items-center gap-1.5">
                  {c.contact ? (
                    <>
                      <Phone className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                      <span className="text-sm text-slate-600">{c.contact}</span>
                    </>
                  ) : (
                    <span className="text-sm text-slate-400">—</span>
                  )}
                </div>

                {/* Transaction count */}
                <div className="flex items-center gap-1">
                  <Receipt className="h-3.5 w-3.5 text-slate-400" />
                  <span className="text-sm font-medium text-slate-700">{c.transactions.length}</span>
                </div>

                {/* Total spent */}
                <p className="text-sm font-semibold text-slate-800">{fmt(c.totalSpent)}</p>

                {/* Expand toggle */}
                <div className="flex justify-end">
                  {isOpen
                    ? <ChevronUp className="h-4 w-4 text-slate-400" />
                    : <ChevronDown className="h-4 w-4 text-slate-400" />
                  }
                </div>
              </div>

              {/* Expanded transaction history */}
              {isOpen && (
                <div className="border-t border-slate-100 bg-slate-50 px-5 py-3">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                    Transaction History
                  </p>
                  <div className="space-y-2">
                    {c.transactions
                      .sort((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0))
                      .map((tx) => (
                        <div
                          key={tx.id}
                          className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-4 py-2.5"
                        >
                          <div className="flex items-center gap-3">
                            {tx.type === 'sale'
                              ? <ShoppingCart className="h-4 w-4 text-violet-500" />
                              : <Calendar className="h-4 w-4 text-blue-500" />
                            }
                            <div>
                              <p className="text-xs font-medium text-slate-700">
                                #{tx.number}
                              </p>
                              <p className="text-xs text-slate-400">
                                {tx.items.map((i) => `${i.name} x${i.quantity}`).join(', ')}
                              </p>
                            </div>
                          </div>
                          <div className="flex items-center gap-3">
                            <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${statusColor[tx.status ?? ''] ?? 'bg-slate-100 text-slate-600'}`}>
                              {tx.status}
                            </span>
                            <p className="text-xs text-slate-400">{fmtDate(tx.date)}</p>
                            <p className="text-sm font-semibold text-slate-800">{fmt(tx.amount)}</p>
                          </div>
                        </div>
                      ))}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
