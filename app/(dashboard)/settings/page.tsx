'use client'

import { useState, useEffect } from 'react'
import {
  EmailAuthProvider,
  reauthenticateWithCredential,
  updatePassword,
  updateProfile,
  onAuthStateChanged,
} from 'firebase/auth'
import { doc, getDoc, updateDoc } from 'firebase/firestore'
import { auth, db } from '@/lib/firebase'
import ProtectedRoute from '@/components/shared/ProtectedRoute'

type Section = 'profile' | 'password'

export default function SettingsPage() {
  return (
    <ProtectedRoute>
      <SettingsContent />
    </ProtectedRoute>
  )
}

function SettingsContent() {
  const [activeSection, setActiveSection] = useState<Section>('profile')

  // Profile state
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [profileLoading, setProfileLoading] = useState(false)
  const [profileError, setProfileError] = useState('')
  const [profileSuccess, setProfileSuccess] = useState('')

  // Password state
  const [current, setCurrent] = useState('')
  const [newPw, setNewPw] = useState('')
  const [confirm, setConfirm] = useState('')
  const [pwLoading, setPwLoading] = useState(false)
  const [pwError, setPwError] = useState('')
  const [pwSuccess, setPwSuccess] = useState('')

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) return
      setEmail(user.email ?? '')
      try {
        const snap = await getDoc(doc(db, 'users', user.uid))
        if (snap.exists()) {
          const data = snap.data() as Record<string, unknown>
          setName(typeof data.name === 'string' ? data.name : user.displayName ?? '')
        } else {
          setName(user.displayName ?? '')
        }
      } catch { setName(user.displayName ?? '') }
    })
    return () => unsub()
  }, [])

  const handleUpdateProfile = async (e: React.FormEvent) => {
    e.preventDefault()
    setProfileError('')
    setProfileSuccess('')
    if (!name.trim()) {
      setProfileError('Name cannot be empty.')
      return
    }
    const user = auth.currentUser
    if (!user) { setProfileError('Session expired. Please log in again.'); return }
    setProfileLoading(true)
    try {
      await updateProfile(user, { displayName: name.trim() })
      await updateDoc(doc(db, 'users', user.uid), { name: name.trim() })
      setProfileSuccess('Profile updated successfully.')
      setTimeout(() => setProfileSuccess(''), 3000)
    } catch {
      setProfileError('Failed to update profile. Please try again.')
    } finally {
      setProfileLoading(false)
    }
  }

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault()
    setPwError('')
    setPwSuccess('')
    if (!current || !newPw || !confirm) { setPwError('All fields are required.'); return }
    if (newPw.length < 6) { setPwError('New password must be at least 6 characters.'); return }
    if (newPw !== confirm) { setPwError('New passwords do not match.'); return }
    if (current === newPw) { setPwError('New password must be different from your current password.'); return }
    const user = auth.currentUser
    if (!user || !user.email) { setPwError('You must be logged in to change your password.'); return }
    setPwLoading(true)
    try {
      const credential = EmailAuthProvider.credential(user.email, current)
      await reauthenticateWithCredential(user, credential)
      await updatePassword(user, newPw)
      setPwSuccess('Password changed successfully.')
      setCurrent(''); setNewPw(''); setConfirm('')
    } catch (err: unknown) {
      const code = (err as { code?: string }).code ?? ''
      if (code === 'auth/wrong-password' || code === 'auth/invalid-credential') {
        setPwError('Current password is incorrect.')
      } else if (code === 'auth/too-many-requests') {
        setPwError('Too many attempts. Please wait a moment and try again.')
      } else if (code === 'auth/requires-recent-login') {
        setPwError('Session expired. Please log out and log back in, then try again.')
      } else {
        setPwError('Failed to change password. Please try again.')
      }
    } finally {
      setPwLoading(false)
    }
  }

  const navItems: { key: Section; label: string; icon: React.ReactNode }[] = [
    {
      key: 'profile',
      label: 'Profile',
      icon: (
        <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
        </svg>
      ),
    },
    {
      key: 'password',
      label: 'Change Password',
      icon: (
        <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
        </svg>
      ),
    },
  ]

  return (
    <main className="min-h-[calc(100vh-64px)] bg-slate-100 px-4 py-8 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-[1700px] space-y-6">

        {/* Page header */}
        <header className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </div>
          <div>
            <h1 className="text-lg font-bold text-slate-900 sm:text-2xl">Settings</h1>
            <p className="mt-0.5 text-sm text-slate-500">Manage your account preferences.</p>
          </div>
        </header>

        {/* Two-column layout */}
        <div className="flex gap-6 items-start">

          {/* Left nav */}
          <aside className="w-52 shrink-0 rounded-xl border bg-white shadow-sm overflow-hidden">
            <div className="px-3 py-3">
              <p className="px-3 pb-1.5 text-[10px] font-bold uppercase tracking-widest text-slate-400">Account</p>
              {navItems.map((item) => (
                <button
                  key={item.key}
                  onClick={() => setActiveSection(item.key)}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm font-medium transition-all ${
                    activeSection === item.key
                      ? 'bg-blue-50 font-semibold text-blue-700'
                      : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                  }`}
                >
                  {item.icon}
                  {item.label}
                </button>
              ))}
            </div>
          </aside>

          {/* Right content */}
          <div className="flex-1 min-w-0">

            {/* Profile Section */}
            {activeSection === 'profile' && (
              <section className="rounded-xl border bg-white shadow-sm">
                <div className="border-b border-slate-100 px-6 py-4">
                  <h2 className="text-base font-bold text-slate-900">Profile</h2>
                  <p className="mt-0.5 text-sm text-slate-500">Update your display name.</p>
                </div>
                <div className="px-6 py-6">
                  {profileError && (
                    <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-600">
                      {profileError}
                    </div>
                  )}
                  {profileSuccess && (
                    <div className="mb-4 rounded-lg border border-green-200 bg-green-50 px-3 py-2.5 text-sm font-medium text-green-700">
                      ✓ {profileSuccess}
                    </div>
                  )}
                  <form onSubmit={handleUpdateProfile} className="max-w-md space-y-4">
                    <div>
                      <label className="mb-1.5 block text-xs font-semibold text-slate-600">Full Name</label>
                      <input
                        type="text"
                        value={name}
                        onChange={e => setName(e.target.value)}
                        placeholder="Your full name"
                        className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                      />
                    </div>
                    <div>
                      <label className="mb-1.5 block text-xs font-semibold text-slate-600">Email Address</label>
                      <input
                        type="email"
                        value={email}
                        disabled
                        className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-400 outline-none cursor-not-allowed"
                      />
                      <p className="mt-1 text-xs text-slate-400">Email cannot be changed here.</p>
                    </div>
                    <div className="pt-1">
                      <button
                        type="submit"
                        disabled={profileLoading}
                        className="rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60 transition"
                      >
                        {profileLoading ? 'Saving…' : 'Save Changes'}
                      </button>
                    </div>
                  </form>
                </div>
              </section>
            )}

            {/* Change Password Section */}
            {activeSection === 'password' && (
              <section className="rounded-xl border bg-white shadow-sm">
                <div className="border-b border-slate-100 px-6 py-4">
                  <h2 className="text-base font-bold text-slate-900">Change Password</h2>
                  <p className="mt-0.5 text-sm text-slate-500">Enter your current password to set a new one.</p>
                </div>
                <div className="px-6 py-6">
                  {pwError && (
                    <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-600">
                      {pwError}
                    </div>
                  )}
                  {pwSuccess && (
                    <div className="mb-4 rounded-lg border border-green-200 bg-green-50 px-3 py-2.5 text-sm font-medium text-green-700">
                      ✓ {pwSuccess}
                    </div>
                  )}
                  <form onSubmit={handleChangePassword} className="max-w-md space-y-4">
                    <div>
                      <label className="mb-1.5 block text-xs font-semibold text-slate-600">Current Password</label>
                      <input
                        type="password"
                        value={current}
                        onChange={e => setCurrent(e.target.value)}
                        placeholder="Enter your current password"
                        className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                      />
                    </div>
                    <div>
                      <label className="mb-1.5 block text-xs font-semibold text-slate-600">New Password</label>
                      <input
                        type="password"
                        value={newPw}
                        onChange={e => setNewPw(e.target.value)}
                        placeholder="Minimum 6 characters"
                        className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                      />
                    </div>
                    <div>
                      <label className="mb-1.5 block text-xs font-semibold text-slate-600">Confirm New Password</label>
                      <input
                        type="password"
                        value={confirm}
                        onChange={e => setConfirm(e.target.value)}
                        placeholder="Re-enter new password"
                        className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                      />
                    </div>
                    <div className="pt-1">
                      <button
                        type="submit"
                        disabled={pwLoading}
                        className="rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60 transition"
                      >
                        {pwLoading ? 'Updating…' : 'Update Password'}
                      </button>
                    </div>
                  </form>
                </div>
              </section>
            )}

          </div>
        </div>
      </div>
    </main>
  )
}
