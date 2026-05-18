'use client'

import { useEffect, useState } from 'react'
import { doc, onSnapshot, updateDoc, collection } from 'firebase/firestore'
import { useRouter } from 'next/navigation'
import { db } from '@/lib/firebase'
import ProtectedRoute from '@/components/shared/ProtectedRoute'
import { useUserRole, UserRole } from '@/hooks/useUserRole'

interface AppUser {
  id: string
  name: string
  email: string
  role: UserRole
  canViewStockLogs: boolean
}

export default function UsersPage() {
  return (
    <ProtectedRoute>
      <UsersContent />
    </ProtectedRoute>
  )
}

function UsersContent() {
  const router = useRouter()
  const { isAdmin, loading: roleLoading } = useUserRole()
  const [users, setUsers] = useState<AppUser[]>([])
  const [updatingUserId, setUpdatingUserId] = useState<string | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!roleLoading && !isAdmin) {
      router.push('/dashboard')
    }
  }, [isAdmin, roleLoading, router])

  useEffect(() => {
    if (!isAdmin) return

    const unsubscribe = onSnapshot(collection(db, 'users'), (snapshot) => {
      const list: AppUser[] = snapshot.docs.map((userDoc) => {
        const data = userDoc.data() as Record<string, unknown>
        return {
          id: userDoc.id,
          name: typeof data.name === 'string' && data.name.trim() ? data.name : 'Unknown User',
          email: typeof data.email === 'string' ? data.email : '',
          role: data.role === 'admin' ? 'admin' : 'staff',
          canViewStockLogs: data.canViewStockLogs === true,
        }
      })

      list.sort((a, b) => a.email.localeCompare(b.email))
      setUsers(list)
    })

    return () => unsubscribe()
  }, [isAdmin])

  const updateRole = async (userId: string, role: UserRole) => {
    setError('')
    setUpdatingUserId(userId)
    try {
      await updateDoc(doc(db, 'users', userId), { role })
    } catch (updateError) {
      console.error('Failed to update role:', updateError)
      setError('Failed to update user role.')
    } finally {
      setUpdatingUserId(null)
    }
  }

  const updateStockLogAccess = async (userId: string, canViewStockLogs: boolean) => {
    setError('')
    setUpdatingUserId(userId)
    try {
      await updateDoc(doc(db, 'users', userId), { canViewStockLogs })
    } catch (updateError) {
      console.error('Failed to update stock log access:', updateError)
      setError('Failed to update stock log access.')
    } finally {
      setUpdatingUserId(null)
    }
  }

  if (roleLoading) {
    return <p className="text-sm text-slate-600">Loading...</p>
  }

  if (!isAdmin) {
    return null
  }

  return (
    <main className="min-h-[calc(100vh-64px)] bg-slate-100 px-4 py-8 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-[1700px] space-y-6">
        <header className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </div>
          <div>
            <h1 className="text-lg font-bold text-slate-900 sm:text-2xl">User Management</h1>
            <p className="mt-0.5 text-sm text-slate-500">Assign admin and staff roles, and control stock log access.</p>
          </div>
        </header>

        <section className="rounded-xl border bg-white p-6 shadow-sm">
          {error && <p className="mb-4 text-sm text-red-600">{error}</p>}
          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-4 py-3 text-left text-sm font-semibold text-slate-700">Name</th>
                  <th className="px-4 py-3 text-left text-sm font-semibold text-slate-700">Email</th>
                  <th className="px-4 py-3 text-left text-sm font-semibold text-slate-700">Role</th>
                  <th className="px-4 py-3 text-left text-sm font-semibold text-slate-700">Stock Logs</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 bg-white">
                {users.map((user) => (
                  <tr key={user.id}>
                    <td className="px-4 py-3 text-sm text-slate-900">{user.name}</td>
                    <td className="px-4 py-3 text-sm text-slate-700">{user.email}</td>
                    <td className="px-4 py-3 text-sm">
                      <select
                        value={user.role}
                        onChange={(event) => updateRole(user.id, event.target.value as UserRole)}
                        disabled={updatingUserId === user.id}
                        className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-slate-500 disabled:opacity-60"
                      >
                        <option value="staff">staff</option>
                        <option value="admin">admin</option>
                      </select>
                    </td>
                    <td className="px-4 py-3 text-sm">
                      <select
                        value={user.canViewStockLogs ? 'allowed' : 'blocked'}
                        onChange={(event) => updateStockLogAccess(user.id, event.target.value === 'allowed')}
                        disabled={updatingUserId === user.id}
                        className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-slate-500 disabled:opacity-60"
                      >
                        <option value="blocked">blocked</option>
                        <option value="allowed">allowed</option>
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  )
}
