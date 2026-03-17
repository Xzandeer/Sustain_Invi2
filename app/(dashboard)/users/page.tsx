'use client'

import { useEffect, useState } from 'react'
import { doc, onSnapshot, updateDoc, collection } from 'firebase/firestore'
import { useRouter } from 'next/navigation'
import { db } from '@/lib/firebase'
import ProtectedRoute from '@/components/ProtectedRoute'
import { useUserRole, UserRole } from '@/hooks/useUserRole'

interface AppUser {
  id: string
  name: string
  email: string
  role: UserRole
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

  if (roleLoading) {
    return <p className="text-sm text-slate-600">Loading...</p>
  }

  if (!isAdmin) {
    return null
  }

  return (
    <main className="min-h-[calc(100vh-64px)] bg-slate-100 px-4 py-8 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-[1700px] space-y-6">
        <header>
          <h1 className="text-4xl font-bold text-slate-900">User Management</h1>
          <p className="mt-1 text-lg text-slate-600">Assign admin and staff roles.</p>
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
