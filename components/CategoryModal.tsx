'use client'

import { useState } from 'react'
import { Trash2, X } from 'lucide-react'

interface Category {
  id: string
  name: string
}

interface CategoryModalProps {
  isOpen: boolean
  onClose: () => void
  categories: Category[]
  onAdd: (name: string) => Promise<void> | void
  onDelete: (id: string) => Promise<void> | void
  deletingCategoryId?: string | null
  adding?: boolean
}

export default function CategoryModal({
  isOpen,
  onClose,
  categories,
  onAdd,
  onDelete,
  deletingCategoryId,
  adding = false,
}: CategoryModalProps) {
  const [name, setName] = useState('')

  if (!isOpen) return null

  const handleAdd = async () => {
    const trimmed = name.trim()
    if (!trimmed) return
    await onAdd(trimmed)
    setName('')
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
      <div className="w-full max-w-xl rounded-xl bg-white p-6 shadow-sm">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xl font-semibold text-slate-900">Categories</h2>
          <button onClick={onClose} className="text-slate-500 transition hover:text-slate-700" title="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="max-h-72 space-y-2 overflow-y-auto rounded-lg border p-3">
          {categories.length > 0 ? (
            categories.map((category) => (
              <div key={category.id} className="flex items-center justify-between rounded-md border px-3 py-2">
                <span className="text-sm text-slate-800">{category.name}</span>
                <button
                  onClick={() => onDelete(category.id)}
                  disabled={deletingCategoryId === category.id}
                  className="inline-flex items-center gap-1 text-sm text-red-600 transition hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Trash2 className="h-4 w-4" />
                  Delete
                </button>
              </div>
            ))
          ) : (
            <p className="text-sm text-slate-500">No categories yet.</p>
          )}
        </div>

        <div className="mt-4 space-y-2">
          <label className="text-sm font-medium text-slate-900">Add Category</label>
          <div className="flex items-center gap-2">
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Category name"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-500"
            />
            <button
              onClick={handleAdd}
              disabled={adding}
              className="rounded-lg bg-sky-900 px-3 py-2 text-sm font-semibold text-white transition hover:bg-sky-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Add
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
