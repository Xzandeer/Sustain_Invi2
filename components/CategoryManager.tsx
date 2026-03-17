'use client'

import { useState } from 'react'
import { Plus, X } from 'lucide-react'

interface Category {
  id: string
  name: string
}

interface CategoryManagerProps {
  categories: Category[]
  onAddCategory: (name: string) => Promise<void> | void
  onRemoveCategory: (categoryId: string) => Promise<void> | void
  deletingCategoryId?: string | null
}

export default function CategoryManager({
  categories,
  onAddCategory,
  onRemoveCategory,
  deletingCategoryId,
}: CategoryManagerProps) {
  const [showInput, setShowInput] = useState(false)
  const [newCategory, setNewCategory] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const handleAdd = async () => {
    const trimmed = newCategory.trim()
    if (!trimmed) return

    setSubmitting(true)
    try {
      await onAddCategory(trimmed)
      setNewCategory('')
      setShowInput(false)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3">
        {categories.map((category) => (
          <div
            key={category.id}
            className="inline-flex items-center gap-2 rounded-full bg-sky-100 px-4 py-2 text-lg font-medium text-sky-900"
          >
            <span>{category.name}</span>
            <button
              onClick={() => onRemoveCategory(category.id)}
              disabled={deletingCategoryId === category.id}
              className="text-sky-900 transition hover:text-sky-700 disabled:cursor-not-allowed disabled:opacity-40"
              title={`Remove ${category.name}`}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>

      {!showInput ? (
        <button
          onClick={() => setShowInput(true)}
          className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-5 py-2.5 text-lg font-medium text-slate-900 transition hover:bg-slate-50"
        >
          <Plus className="h-5 w-5" />
          Add New Category
        </button>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <input
            value={newCategory}
            onChange={(event) => setNewCategory(event.target.value)}
            placeholder="Category name"
            className="w-full max-w-xs rounded-lg border border-slate-300 px-4 py-2.5 text-base text-slate-900 outline-none transition focus:border-sky-700"
          />
          <button
            onClick={handleAdd}
            disabled={submitting}
            className="rounded-lg bg-sky-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? 'Adding...' : 'Add'}
          </button>
          <button
            onClick={() => {
              setShowInput(false)
              setNewCategory('')
            }}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}
