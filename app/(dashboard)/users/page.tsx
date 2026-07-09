'use client'

import { useEffect, useState } from 'react'
import { doc, getDocs, updateDoc, collection } from 'firebase/firestore'
import { sendPasswordResetEmail, reauthenticateWithCredential, EmailAuthProvider } from 'firebase/auth'
import { useRouter } from 'next/navigation'
import { db, auth } from '@/lib/firebase'
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
  const [successMsg, setSuccessMsg] = useState('')

  // Add account modal
  const [showModal, setShowModal] = useState(false)
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'staff' as UserRole })
  const [formError, setFormError] = useState('')
  const [creating, setCreating] = useState(false)

  // Reset password confirmation modal
  const [resetTarget, setResetTarget] = useState<AppUser | null>(null)
  const [adminPassword, setAdminPassword] = useState('')
  const [resetError, setResetError] = useState('')
  const [resetLoading, setResetLoading] = useState(false)

  useEffect(() => {
    if (!roleLoading && !isAdmin) router.push('/dashboard')
  }, [isAdmin, roleLoading, router])

  async function loadUsers() {
    try {
      const snap = await getDocs(collection(db, 'users'))
      const list: AppUser[] = snap.docs.map((userDoc) => {
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
    } catch (_) {}
  }

  useEffect(() => {
    if (!isAdmin) return
    loadUsers()
  }, [isAdmin])

  const updateRole = async (userId: string, role: UserRole) => {
    setError('')
    setUpdatingUserId(userId)
    try {
      await updateDoc(doc(db, 'users', userId), { role })
      setUsers(prev => prev.map(u => u.id === userId ? { ...u, role } : u))
    } catch { setError('Failed to update user role.') }
    finally { setUpdatingUserId(null) }
  }

  const updateStockLogAccess = async (userId: string, canViewStockLogs: boolean) => {
    setError('')
    setUpdatingUserId(userId)
    try {
      await updateDoc(doc(db, 'users', userId), { canViewStockLogs })
      setUsers(prev => prev.map(u => u.id === userId ? { ...u, canViewStockLogs } : u))
    } catch { setError('Failed to update stock log access.') }
    finally { setUpdatingUserId(null) }
  }

  // Step 1: open confirmation modal
  const promptResetPassword = (user: AppUser) => {
    setResetTarget(user)
    setAdminPassword('')
    setResetError('')
  }

  // Step 2: verify admin password then send reset email
  const handleConfirmReset = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!resetTarget) return
    setResetError('')

    if (!adminPassword) {
      setResetError('Please enter your password.')
      return
    }

    const currentUser = auth.currentUser
    if (!currentUser || !currentUser.email) {
      setResetError('Session expired. Please log in again.')
      return
    }

    setResetLoading(true)
    try {
      // Verify admin's own password first
      const credential = EmailAuthProvider.credential(currentUser.email, adminPassword)
      await reauthenticateWithCredential(currentUser, credential)

      // Password confirmed — send reset email to target user
      await sendPasswordResetEmail(auth, resetTarget.email)

      setResetTarget(null)
      setAdminPassword('')
      setSuccessMsg(`Password reset email sent to ${resetTarget.email}.`)
      setTimeout(() => setSuccessMsg(''), 5000)
    } catch (err: unknown) {
      const code = (err as { code?: string }).code ?? ''
      if (code === 'auth/wrong-password' || code === 'auth/invalid-credential') {
        setResetError('Incorrect password. Please try again.')
      } else if (code === 'auth/too-many-requests') {
        setResetError('Too many attempts. Please wait a moment.')
      } else {
        setResetError('Verification failed. Please try again.')
      }
    } finally {
      setResetLoading(false)
    }
  }

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault()
    setFormError('')
    if (!form.name.trim() || !form.email.trim() || !form.password) {
      setFormError('All fields are required.')
      return
    }
    if (form.password.length < 6) {
      setFormError('Password must be at least 6 characters.')
      return
    }
    setCreating(true)
    try {
      const res = await fetch('/api/admin/create-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = await res.json()
      if (!res.ok) { setFormError(data.error ?? 'Failed to create account.'); return }
      setShowModal(false)
      setForm({ name: '', email: '', password: '', role: 'staff' })
      setSuccessMsg(`Account for ${form.email} created successfully.`)
      setTimeout(() => setSuccessMsg(''), 4000)
      await loadUsers()
    } catch { setFormError('Network error. Please try again.') }
    finally { setCreating(false) }
  }

  if (roleLoading) return <p className="p-8 text-sm text-slate-600">Loading...</p>
  if (!isAdmin) return null

  return (
    <main className="min-h-[calc(100vh-64px)] bg-slate-100 px-4 py-8 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-[1700px] space-y-6">
        <header className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </div>
            <div>
              <h1 className="text-lg font-bold text-slate-900 sm:text-2xl">User Management</h1>
              <p className="mt-0.5 text-sm text-slate-500">Manage accounts, roles, and permissions.</p>
            </div>
          </div>
          <button
            onClick={() => { setShowModal(true); setFormError('') }}
            className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 transition"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            Add Account
          </button>
        </header>

        {successMsg && (
          <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm font-medium text-green-700">
            &#10003; {successMsg}
          </div>
        )}
        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
            {error}
          </div>
        )}

        <section className="rounded-xl border bg-white p-6 shadow-sm">
          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-4 py-3 text-left text-sm font-semibold text-slate-700">Name</th>
                  <th className="px-4 py-3 text-left text-sm font-semibold text-slate-700">Email</th>
                  <th className="px-4 py-3 text-left text-sm font-semibold text-slate-700">Role</th>
                  <th className="px-4 py-3 text-left text-sm font-semibold text-slate-700">Stock Logs</th>
                  <th className="px-4 py-3 text-left text-sm font-semibold text-slate-700">Password</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 bg-white">
                {users.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-sm text-slate-400">No users found.</td>
                  </tr>
                )}
                {users.map((user) => (
                  <tr key={user.id}>
                    <td className="px-4 py-3 text-sm text-slate-900">{user.name}</td>
                    <td className="px-4 py-3 text-sm text-slate-700">{user.email}</td>
                    <td className="px-4 py-3 text-sm">
                      <select
                        value={user.role}
                        onChange={(e) => updateRole(user.id, e.target.value as UserRole)}
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
                        onChange={(e) => updateStockLogAccess(user.id, e.target.value === 'allowed')}
                        disabled={updatingUserId === user.id}
                        className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-slate-500 disabled:opacity-60"
                      >
                        <option value="blocked">blocked</option>
                        <option value="allowed">allowed</option>
                      </select>
                    </td>
                    <td className="px-4 py-3 text-sm">
                      <button
                        onClick={() => promptResetPassword(user)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 transition"
                      >
                        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                        </svg>
                        Send Reset
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {/* ── Admin password confirmation modal ── */}
      {resetTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-100 px-6 py-4">
              <h2 className="text-base font-bold text-slate-900">Confirm Your Identity</h2>
              <button
                onClick={() => { setResetTarget(null); setAdminPassword(''); setResetError('') }}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition"
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <form onSubmit={handleConfirmReset} className="space-y-4 px-6 py-5">
              <p className="text-sm text-slate-600">
                A password reset link will be sent to{' '}
                <span className="font-semibold text-slate-900">{resetTarget.email}</span>.
                Enter your admin password to confirm.
              </p>

              {resetError && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
                  {resetError}
                </div>
              )}

              <div>
                <label className="mb-1.5 block text-xs font-semibold text-slate-600">
                  Your Admin Password
                </label>
                <input
                  type="password"
                  value={adminPassword}
                  onChange={e => setAdminPassword(e.target.value)}
                  placeholder="Enter your password"
                  autoFocus
                  className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                />
              </div>

              <div className="flex gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => { setResetTarget(null); setAdminPassword(''); setResetError('') }}
                  className="flex-1 rounded-xl border border-slate-200 py-2.5 text-sm font-semibold text-slate-600 hover:bg-slate-50 transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={resetLoading}
                  className="flex-1 rounded-xl bg-blue-600 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60 transition"
                >
                  {resetLoading ? 'Verifying…' : 'Send Reset Link'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Add account modal ── */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-100 px-6 py-4">
              <h2 className="text-base font-bold text-slate-900">Add New Account</h2>
              <button
                onClick={() => setShowModal(false)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition"
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <form onSubmit={handleCreateUser} className="space-y-4 px-6 py-5">
              {formError && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
                  {formError}
                </div>
              )}
              <div>
                <label className="mb-1.5 block text-xs font-semibold text-slate-600">Full Name</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="e.g. Juan dela Cruz"
                  className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-semibold text-slate-600">Email Address</label>
                <input
                  type="email"
                  value={form.email}
                  onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                  placeholder="e.g. juan@email.com"
                  className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-semibold text-slate-600">Password</label>
                <input
                  type="password"
                  value={form.password}
                  onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                  placeholder="Minimum 6 characters"
                  className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-semibold text-slate-600">Role</label>
                <select
                  value={form.role}
                  onChange={e => setForm(f => ({ ...f, role: e.target.value as UserRole }))}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                >
                  <option value="staff">Staff</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
              <div className="flex gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="flex-1 rounded-xl border border-slate-200 py-2.5 text-sm font-semibold text-slate-600 hover:bg-slate-50 transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="flex-1 rounded-xl bg-blue-600 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60 transition"
                >
                  {creating ? 'Creating…' : 'Create Account'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </main>
  )
}
