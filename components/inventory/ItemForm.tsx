'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'

interface ItemFormProps {
  isOpen: boolean
  onClose: () => void
  onSubmit: (item: any) => void
  editItem?: any
  canEditPrice: boolean

  categoriesList: string[]
  conditionsList: string[]
  statusesList: string[]
}

export default function ItemForm({
  isOpen,
  onClose,
  onSubmit,
  editItem,
  canEditPrice,
  categoriesList,
  conditionsList,
  statusesList,
}: ItemFormProps) {
  
  const today = new Date().toISOString().split("T")[0]

  const [name, setName] = useState('')
  const [category, setCategory] = useState('')
  const [condition, setCondition] = useState('')
  const [price, setPrice] = useState<number>(0)
  const [status, setStatus] = useState('In Stock')
  const [dateAdded, setDateAdded] = useState(today)

  useEffect(() => {
    if (editItem) {
      setName(editItem.name)
      setCategory(editItem.category)
      setCondition(editItem.condition)
      setPrice(editItem.price)
      setStatus(editItem.status)
      setDateAdded(new Date(editItem.timestamp).toISOString().split("T")[0])
    } else {
      setName('')
      setCategory('')
      setCondition('')
      setPrice(0)
      setStatus('In Stock')
      setDateAdded(today)
    }
  }, [editItem])

  if (!isOpen) return null

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()

    const unixTimestamp = new Date(dateAdded).getTime()

    // FIX: prevent sending undefined "id" to Firestore
    const itemToSave: any = {
      name,
      category,
      condition,
      price,
      status,
      timestamp: unixTimestamp,
    }

    if (editItem?.id) {
      itemToSave.id = editItem.id // only include ID on edit
    }

    onSubmit(itemToSave)
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-slate-800 p-6 rounded-lg w-96 shadow-lg">
        <h2 className="text-xl font-bold mb-4 text-gray-900 dark:text-white">
          {editItem ? 'Edit Item' : 'Add Item'}
        </h2>

        <form onSubmit={handleSubmit} className="space-y-4">

          <div>
            <label className="text-sm font-medium">Item Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className="w-full px-3 py-2 border rounded-lg dark:bg-slate-700 dark:text-white"
            />
          </div>

          <div>
            <label className="text-sm font-medium">Category</label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              required
              className="w-full px-3 py-2 border rounded-lg dark:bg-slate-700 dark:text-white"
            >
              <option value="">Select category</option>
              {categoriesList.map((cat) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-sm font-medium">Condition</label>
            <select
              value={condition}
              onChange={(e) => setCondition(e.target.value)}
              required
              className="w-full px-3 py-2 border rounded-lg dark:bg-slate-700 dark:text-white"
            >
              <option value="">Select condition</option>
              {conditionsList.map((cond) => (
                <option key={cond} value={cond}>
                  {cond}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-sm font-medium">Price (₱)</label>
            <input
              type="number"
              value={price}
              onChange={(e) => setPrice(Number(e.target.value))}
              disabled={!canEditPrice}
              required
              className={`w-full px-3 py-2 border rounded-lg dark:bg-slate-700 dark:text-white ${
                !canEditPrice ? 'opacity-60 cursor-not-allowed' : ''
              }`}
            />
          </div>

          <div>
            <label className="text-sm font-medium">Date Added</label>
            <input
              type="date"
              value={dateAdded}
              max={today}
              onChange={(e) => setDateAdded(e.target.value)}
              required
              className="w-full px-3 py-2 border rounded-lg dark:bg-slate-700 dark:text-white"
            />
          </div>

          <div>
            <label className="text-sm font-medium">Status</label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg dark:bg-slate-700 dark:text-white"
            >
              {statusesList.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>

          <div className="flex gap-2 mt-4">
            <Button type="submit" className="bg-green-600 text-white flex-1">
              {editItem ? 'Save Changes' : 'Add Item'}
            </Button>
            <Button type="button" onClick={onClose} className="bg-gray-400 text-white flex-1">
              Cancel
            </Button>
          </div>

        </form>
      </div>
    </div>
  )
}
