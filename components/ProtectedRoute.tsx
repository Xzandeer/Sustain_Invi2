'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { onAuthStateChanged } from 'firebase/auth'
import { auth } from '@/lib/firebase'
import { useUserRole } from '@/hooks/useUserRole'

interface ProtectedRouteProps {
  children: React.ReactNode
  requireAdmin?: boolean
  allowStockLogs?: boolean
}

export default function ProtectedRoute({
  children,
  requireAdmin = false,
  allowStockLogs = false,
}: ProtectedRouteProps) {
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [authenticated, setAuthenticated] = useState(false)
  const { isAdmin, canViewStockLogs, loading: roleLoading } = useUserRole()

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user) {
        setAuthenticated(true)
        setLoading(false)
      } else {
        setAuthenticated(false)
        setLoading(false)
        router.replace('/login')
      }
    })

    return () => unsubscribe()
  }, [router])

  useEffect(() => {
    if (loading || roleLoading || !authenticated) {
      return
    }

    if (requireAdmin && !isAdmin) {
      router.replace('/dashboard')
      return
    }

    if (allowStockLogs && !isAdmin && !canViewStockLogs) {
      router.replace('/dashboard')
    }
  }, [allowStockLogs, authenticated, canViewStockLogs, isAdmin, loading, requireAdmin, roleLoading, router])

  if (loading || roleLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-gray-600">Loading...</p>
      </div>
    )
  }

  if (!authenticated) {
    return null
  }

  if ((requireAdmin && !isAdmin) || (allowStockLogs && !isAdmin && !canViewStockLogs)) {
    return null
  }

  return <>{children}</>
}
