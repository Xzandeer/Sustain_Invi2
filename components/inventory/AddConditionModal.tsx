'use client'

import { useState } from 'react'
import { collection, addDoc } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { Button } from '@/components/ui/button'

interface AddConditionModalProps {
  isOpen: boolean
  onClose: () => void
  onSuccess: () => void
}

export default function AddConditionModal({ isOpen, onClose, onSuccess }: AddConditionModalProps) {
  const [conditionName, setConditionName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!conditionName.trim()) {
      setError('Condition name is required')
      return
    }

    setLoading(true)
    try {
      await addDoc(collection(db, 'conditions'), {
        name: conditionName,
        timestamp: Date.now(),
      })
      setConditionName('')
      setError('')
      onSuccess()
      onClose()
    } catch (err) {
      setError('Failed to add condition')
      console.error('Error adding condition:', err)
    } finally {
      setLoading(false)
    }
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-slate-800 rounded-lg p-6 w-96">
        <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-4">Add Condition</h2>
        <form onSubmit={handleSubmit}>
          <input
            type="text"
            placeholder="Condition name"
            value={conditionName}
            onChange={(e) => setConditionName(e.target.value)}
            className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500 dark:bg-slate-700 dark:text-white mb-4"
          />
          {error && <p className="text-red-500 text-sm mb-4">{error}</p>}
          <div className="flex gap-2">
            <Button
              type="submit"
              disabled={loading}
              className="bg-green-600 hover:bg-green-700 text-white flex-1"
            >
              {loading ? 'Adding...' : 'Add'}
            </Button>
            <Button
              type="button"
              onClick={onClose}
              className="bg-gray-400 hover:bg-gray-500 text-white flex-1"
            >
              Cancel
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
