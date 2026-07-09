'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { onAuthStateChanged, signInWithEmailAndPassword, sendPasswordResetEmail } from 'firebase/auth'
import { doc, getDoc } from 'firebase/firestore'
import { auth, db } from '@/lib/firebase'
import { Spinner } from '@/components/ui/spinner'

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  // Forgot password state
  const [showForgot, setShowForgot] = useState(false)
  const [resetEmail, setResetEmail] = useState('')
  const [resetSending, setResetSending] = useState(false)
  const [resetMsg, setResetMsg] = useState('')
  const [resetError, setResetError] = useState('')

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user) router.replace('/dashboard')
    })
    return () => unsubscribe()
  }, [router])

  const getErrorMessage = (code: string) => {
    if (code === 'auth/invalid-credential' || code === 'auth/wrong-password')
      return 'Invalid email or password'
    if (code === 'auth/user-not-found') return 'User not found'
    if (code === 'auth/network-request-failed') return 'Network error'
    return 'Unable to sign in. Please try again.'
  }

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError('')
    const normalizedEmail = email.trim()
    if (!normalizedEmail || !password) {
      setError('Email and password are required.')
      return
    }
    setLoading(true)
    try {
      const userCredential = await signInWithEmailAndPassword(auth, normalizedEmail, password)
      const userSnapshot = await getDoc(doc(db, 'users', userCredential.user.uid))
      const role = userSnapshot.exists() ? userSnapshot.data().role : 'staff'
      if (role === 'admin' || role === 'staff') {
        router.replace('/dashboard')
        return
      }
      router.replace('/dashboard')
    } catch (err: unknown) {
      const code = typeof err === 'object' && err && 'code' in err ? String(err.code) : ''
      setError(getErrorMessage(code))
    } finally {
      setLoading(false)
    }
  }

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault()
    setResetError('')
    setResetMsg('')
    const trimmed = resetEmail.trim()
    if (!trimmed) {
      setResetError('Please enter your email address.')
      return
    }
    setResetSending(true)
    try {
      await sendPasswordResetEmail(auth, trimmed)
      setResetMsg('Reset link sent! Check your email inbox (and spam folder).')
      setResetEmail('')
    } catch (err: unknown) {
      const code = typeof err === 'object' && err && 'code' in err ? String(err.code) : ''
      if (code === 'auth/user-not-found' || code === 'auth/invalid-email') {
        setResetError('No account found with that email address.')
      } else {
        setResetError('Failed to send reset email. Please try again.')
      }
    } finally {
      setResetSending(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4 py-10">
      <div className="w-full max-w-md rounded-xl bg-white p-8 shadow">
        <h1 className="mb-8 text-center text-3xl font-bold text-slate-900">Sign In</h1>

        {!showForgot ? (
          <>
            <form onSubmit={onSubmit} className="space-y-4">
              <div>
                <label className="mb-2 block text-sm font-medium text-slate-700">Email</label>
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="Enter your email"
                  className="w-full rounded-lg border border-slate-300 px-4 py-2 text-slate-900 outline-none transition focus:border-slate-500"
                  required
                />
              </div>

              <div>
                <label className="mb-2 block text-sm font-medium text-slate-700">Password</label>
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Enter your password"
                  className="w-full rounded-lg border border-slate-300 px-4 py-2 text-slate-900 outline-none transition focus:border-slate-500"
                  required
                />
                <div className="mt-3 flex justify-end">
                  <button
                    type="button"
                    onClick={() => { setShowForgot(true); setResetEmail(email.trim()); setResetMsg(''); setResetError('') }}
                    className="text-sm font-medium text-blue-600 hover:underline"
                  >
                    Forgot password?
                  </button>
                </div>
              </div>

              {error && <p className="text-sm text-red-600">{error}</p>}

              <button
                type="submit"
                disabled={loading}
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-sky-900 py-2 font-semibold text-white transition hover:bg-sky-800 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {loading ? (
                  <>
                    <Spinner className="size-4" />
                    Signing in...
                  </>
                ) : (
                  'Login'
                )}
              </button>
            </form>
          </>
        ) : (
          <>
            <div className="mb-5">
              <h2 className="text-lg font-bold text-slate-900">Reset Password</h2>
              <p className="mt-1 text-sm text-slate-500">
                Enter your account email and we&apos;ll send you a reset link.
              </p>
            </div>

            {resetMsg ? (
              <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm font-medium text-green-700">
                ✓ {resetMsg}
              </div>
            ) : (
              <form onSubmit={handleResetPassword} className="space-y-4">
                {resetError && (
                  <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
                    {resetError}
                  </div>
                )}
                <div>
                  <label className="mb-2 block text-sm font-medium text-slate-700">Email Address</label>
                  <input
                    type="email"
                    value={resetEmail}
                    onChange={e => setResetEmail(e.target.value)}
                    placeholder="Enter your email"
                    className="w-full rounded-lg border border-slate-300 px-4 py-2 text-slate-900 outline-none transition focus:border-slate-500"
                    autoFocus
                  />
                </div>
                <button
                  type="submit"
                  disabled={resetSending}
                  className="w-full rounded-lg bg-blue-600 py-2 font-semibold text-white hover:bg-blue-700 disabled:opacity-60 transition"
                >
                  {resetSending ? 'Sending…' : 'Send Reset Link'}
                </button>
              </form>
            )}

            <button
              type="button"
              onClick={() => { setShowForgot(false); setResetMsg(''); setResetError('') }}
              className="mt-4 flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-700 transition"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
              </svg>
              Back to Sign In
            </button>
          </>
        )}
      </div>
    </div>
  )
}
