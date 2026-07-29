// Protected route wrapper - checks authentication and role-based permissions
'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { onAuthStateChanged } from 'firebase/auth'
import { auth } from '@/lib/firebase'
import { useUserRole } from '@/hooks/useUserRole'
import { Permission } from '@/lib/auth/permissions'

interface ProtectedRouteProps {
  children: React.ReactNode
  requireAdmin?: boolean
  allowStockLogs?: boolean
  /** Page requires this specific permission. Admins always pass. */
  requirePermission?: Permission
}

export default function ProtectedRoute({
  children,
  requireAdmin = false,
  allowStockLogs = false,
  requirePermission,
}: ProtectedRouteProps) {
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [authenticated, setAuthenticated] = useState(false)
  const { isAdmin, canViewStockLogs, can, loading: roleLoading } = useUserRole()

  const permissionDenied = !!requirePermission && !isAdmin && !can(requirePermission)

  // Step 1: Check if user is logged in
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user) {
        setAuthenticated(true)
        setLoading(false)
      } else {
        setAuthenticated(false)
        setLoading(false)
        // Not logged in - redirect to login page
        router.replace('/login')
      }
    })

    return () => unsubscribe()
  }, [router])

  // Step 2: Check role-based permissions once roles are loaded
  useEffect(() => {
    if (loading || roleLoading || !authenticated) {
      return
    }

    // Redirect if admin access is required but user is not admin
    if (requireAdmin && !isAdmin) {
      router.replace('/dashboard')
      return
    }

    // Redirect if stock logs access is required but user doesn't have permission
    if (allowStockLogs && !isAdmin && !canViewStockLogs) {
      router.replace('/dashboard')
      return
    }

    // Redirect if a specific feature permission is required but missing
    if (permissionDenied) {
      router.replace('/dashboard')
    }
  }, [allowStockLogs, authenticated, canViewStockLogs, isAdmin, loading, permissionDenied, requireAdmin, roleLoading, router])

  // Show loading spinner while checking auth or role
  if (loading || roleLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-gray-600">Loading...</p>
      </div>
    )
  }

  // Render nothing if not authenticated (redirect is already happening)
  if (!authenticated) {
    return null
  }

  // Render nothing if role check fails (redirect is already happening)
  if ((requireAdmin && !isAdmin) || (allowStockLogs && !isAdmin && !canViewStockLogs) || permissionDenied) {
    return null
  }

  // All checks passed - render the protected page
  return <>{children}</>
}
