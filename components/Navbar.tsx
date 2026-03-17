'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { signOut } from 'firebase/auth'
import { auth } from '@/lib/firebase'
import Link from 'next/link'

export default function Navbar() {
  const router = useRouter()
  const [user, setUser] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const unsubscribe = auth.onAuthStateChanged((currentUser) => {
      setUser(currentUser)
      setLoading(false)
      if (!currentUser) {
        router.push('/login')
      }
    })

    return () => unsubscribe()
  }, [router])

  const handleLogout = async () => {
    try {
      await signOut(auth)
      router.push('/login')
    } catch (error) {
      console.error('Logout failed:', error)
    }
  }

  if (loading) {
    return null
  }

  if (!user) {
    return null
  }

  return (
    <nav className="bg-gradient-to-r from-green-600 to-green-700 text-white shadow-lg">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          <div className="flex items-center space-x-8">
            <Link href="/dashboard" className="font-bold text-xl hover:opacity-90 transition">
              SUSTAIN
            </Link>
            <div className="flex space-x-4">
              <Link href="/dashboard" className="hover:bg-green-500 px-3 py-2 rounded-md text-sm font-medium transition">
                Dashboard
              </Link>
              <Link href="/inventory" className="hover:bg-green-500 px-3 py-2 rounded-md text-sm font-medium transition">
                Items
              </Link>
              <Link href="/sales" className="hover:bg-green-500 px-3 py-2 rounded-md text-sm font-medium transition">
                Sales
              </Link>
            </div>
          </div>

          <div className="flex items-center space-x-4">
            <span className="text-sm">{user?.email}</span>
            <button
              onClick={handleLogout}
              className="bg-red-600 hover:bg-red-700 px-4 py-2 rounded-md text-sm font-medium transition"
            >
              Logout
            </button>
          </div>
        </div>
      </div>
    </nav>
  )
}
