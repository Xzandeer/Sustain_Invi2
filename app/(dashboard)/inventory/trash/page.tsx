'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { collection, onSnapshot } from 'firebase/firestore'
import { ArrowLeft, RotateCcw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import ProtectedRoute from '@/components/ProtectedRoute'
import { auth, db } from '@/lib/firebase'
import { normalizeInventoryCondition } from '@/lib/server/salesInventoryMetrics'
import { useUserRole } from '@/hooks/useUserRole'

interface DeletedItem {
  id: string
  name: string
  category: string
  condition: 'New' | 'Refurbished'
  deletedAt: string | null
}

const formatDeletedAt = (value: string | null) => {
  if (!value) return 'Unknown'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString('en-PH')
}

export default function InventoryTrashPage() {
  return (
    <ProtectedRoute requireAdmin>
      <InventoryTrashContent />
    </ProtectedRoute>
  )
}

function InventoryTrashContent() {
  const { isAdmin } = useUserRole()
  const [items, setItems] = useState<DeletedItem[]>([])
  const [loading, setLoading] = useState(true)
  const [actionId, setActionId] = useState<string | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    const unsubscribe = onSnapshot(
      collection(db, 'inventory'),
      (snapshot) => {
        const rows = snapshot.docs
          .map((docItem) => {
            const data = docItem.data() as Record<string, unknown>
            return {
              id: docItem.id,
              name: typeof data.name === 'string' ? data.name.trim() : '',
              category:
                (typeof data.categoryName === 'string' && data.categoryName.trim()) ||
                (typeof data.category === 'string' && data.category.trim()) ||
                'Uncategorized',
              condition: normalizeInventoryCondition(data.status),
              deletedAt: typeof data.deletedAt === 'string' ? data.deletedAt : null,
              isDeleted: data.isDeleted === true,
            }
          })
          .filter((item) => item.name && item.isDeleted)
          .sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? ''))

        setItems(rows)
        setLoading(false)
      },
      (snapshotError) => {
        console.error('Error loading deleted inventory:', snapshotError)
        setError('Failed to load deleted inventory.')
        setLoading(false)
      }
    )

    return () => unsubscribe()
  }, [])

  const emptyMessage = useMemo(() => {
    if (loading) return 'Loading deleted items...'
    if (items.length === 0) return 'Trash is empty.'
    return ''
  }, [items.length, loading])

  const handleAction = async (id: string, action: 'restore' | 'permanent-delete') => {
    if (!isAdmin) return
    setError('')
    setActionId(id)
    try {
      const response = await fetch(`/api/inventory/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          processedBy: {
            uid: auth.currentUser?.uid ?? '',
            email: auth.currentUser?.email ?? '',
            name: auth.currentUser?.displayName ?? auth.currentUser?.email ?? '',
          },
        }),
      })
      const payload = (await response.json()) as { error?: string }
      if (!response.ok) {
        throw new Error(payload.error || 'Action failed.')
      }
      toast.success(action === 'restore' ? 'Item restored successfully.' : 'Item deleted permanently.')
    } catch (actionError) {
      const message = actionError instanceof Error ? actionError.message : 'Action failed.'
      setError(message)
      toast.error(message)
    } finally {
      setActionId(null)
    }
  }

  return (
    <main className="min-h-[calc(100vh-64px)] bg-slate-100 px-2.5 py-3 sm:px-3">
      <div className="mx-auto max-w-[1620px] space-y-4">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-[1.65rem] font-bold text-slate-900">Inventory Trash</h1>
          </div>
          <Link
            href="/inventory"
            className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-900 transition hover:bg-slate-50"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Inventory
          </Link>
        </header>

        <section className="rounded-xl border bg-white p-4 shadow-sm">
          {error && <p className="mb-4 text-sm text-red-600">{error}</p>}
          {emptyMessage ? (
            <p className="text-sm text-slate-500">{emptyMessage}</p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-200">
              <table className="min-w-full divide-y divide-slate-200">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-sm font-semibold text-slate-700">Item</th>
                    <th className="px-4 py-3 text-left text-sm font-semibold text-slate-700">Category</th>
                    <th className="px-4 py-3 text-left text-sm font-semibold text-slate-700">Condition</th>
                    <th className="px-4 py-3 text-left text-sm font-semibold text-slate-700">Deleted At</th>
                    <th className="px-4 py-3 text-left text-sm font-semibold text-slate-700">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 bg-white">
                  {items.map((item) => (
                    <tr key={item.id} className="hover:bg-slate-50">
                      <td className="px-4 py-3 text-sm font-medium text-slate-900">{item.name}</td>
                      <td className="px-4 py-3 text-sm text-slate-700">{item.category}</td>
                      <td className="px-4 py-3 text-sm text-slate-700">{item.condition}</td>
                      <td className="px-4 py-3 text-sm text-slate-700">{formatDeletedAt(item.deletedAt)}</td>
                      <td className="px-4 py-3 text-sm">
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            disabled={!isAdmin || actionId === item.id}
                            onClick={() => handleAction(item.id, 'restore')}
                            className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-900 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            <RotateCcw className="h-4 w-4" />
                            Restore
                          </button>
                          <button
                            type="button"
                            disabled={!isAdmin || actionId === item.id}
                            onClick={() => handleAction(item.id, 'permanent-delete')}
                            className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            <Trash2 className="h-4 w-4" />
                            Delete Permanently
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </main>
  )
}
