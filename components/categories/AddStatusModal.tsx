'use client'

import { useState } from 'react'
import { collection, addDoc } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { Button } from '@/components/ui/button'

interface AddStatusModalProps {
  isOpen: boolean
  onClose: () => void
  onSuccess: () => void
}

export default function AddStatusModal({ isOpen, onClose, onSuccess }: AddStatusModalProps) {
  const [statusName, setStatusName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!statusName.trim()) {
      setError('Status name is required')
      return
    }

    setLoading(true)
    try {
      await addDoc(collection(db, 'statuses'), {
        name: statusName,
        timestamp: Date.now(),
      })
      setStatusName('')
      setError('')
      onSuccess()
      onClose()
    } catch (err) {
      setError('Failed to add status')
      console.error('Error adding status:', err)
    } finally {
      setLoading(false)
    }
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-slate-800 rounded-lg p-6 w-96">
        <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-4">Add Status</h2>
        <form onSubmit={handleSubmit}>
          <input
            type="text"
            placeholder="Status name"
            value={statusName}
            onChange={(e) => setStatusName(e.target.value)}
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
