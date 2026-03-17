'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { onAuthStateChanged, signInWithEmailAndPassword } from 'firebase/auth'
import { doc, getDoc } from 'firebase/firestore'
import { auth, db } from '@/lib/firebase'
import { Spinner } from '@/components/ui/spinner'

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user) {
        router.replace('/dashboard')
      }
    })

    return () => unsubscribe()
  }, [router])

  const getErrorMessage = (code: string) => {
    if (code === 'auth/invalid-credential' || code === 'auth/wrong-password') {
      return 'Invalid email or password'
    }

    if (code === 'auth/user-not-found') {
      return 'User not found'
    }

    if (code === 'auth/network-request-failed') {
      return 'Network error'
    }

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

  return (
    <div className="min-h-screen bg-slate-100 px-4 flex items-center justify-center">
      <div className="w-full max-w-md rounded-xl bg-white p-8 shadow">
        <h1 className="mb-6 text-center text-3xl font-bold text-slate-900">Sign In</h1>

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
                Signing In...
              </>
            ) : (
              'Sign In'
            )}
          </button>
        </form>

        <p className="mt-6 text-center text-slate-600">
          Don't have an account?{' '}
          <Link href="/signup" className="font-semibold text-sky-900 hover:underline">
            Sign up
          </Link>
        </p>
      </div>
    </div>
  )
}
