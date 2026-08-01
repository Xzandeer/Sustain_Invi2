'use client'

// Reads the signed-in user's role and permissions.
//
// Returns:
//   role                - 'admin' or 'staff'
//   isAdmin             - convenience flag
//   isDisabled          - account switched off by an admin
//   permissions         - the resolved permission set
//   can(permission)     - check a single permission
//   loading             - true until the profile has been read
//
// Admins always resolve to every permission granted, so a permission check
// never has to special-case them.
//
// If the account is disabled, this signs the user out immediately rather than
// leaving them on screen with a broken session.
//
// This is the CLIENT-side check and only controls what the UI shows. The real
// enforcement is checkPermission() in lib/server/authorize.ts, which every
// sensitive API route calls. Never rely on this hook alone to protect data.

import { useEffect, useState } from 'react'
import { onAuthStateChanged, signOut } from 'firebase/auth'
import { doc, getDoc } from 'firebase/firestore'
import { auth, db } from '@/lib/firebase'
import {
  PermissionSet,
  DEFAULT_STAFF_PERMISSIONS,
  ALL_PERMISSIONS_GRANTED,
  resolvePermissions,
  Permission,
} from '@/lib/auth/permissions'

export type UserRole = 'admin' | 'staff'

export const useUserRole = () => {
  const [role, setRole] = useState<UserRole>('staff')
  const [permissions, setPermissions] = useState<PermissionSet>(DEFAULT_STAFF_PERMISSIONS)
  const [isDisabled, setIsDisabled] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        setRole('staff')
        setPermissions(DEFAULT_STAFF_PERMISSIONS)
        setIsDisabled(false)
        setLoading(false)
        return
      }

      try {
        const snapshot = await getDoc(doc(db, 'users', user.uid))
        const data = snapshot.exists() ? (snapshot.data() as Record<string, unknown>) : undefined
        const resolvedRole: UserRole = data?.role === 'admin' ? 'admin' : 'staff'

        // A disabled account is signed out immediately.
        if (data?.isDisabled === true) {
          setIsDisabled(true)
          setRole('staff')
          setPermissions(DEFAULT_STAFF_PERMISSIONS)
          setLoading(false)
          await signOut(auth).catch(() => {})
          return
        }

        setIsDisabled(false)
        setRole(resolvedRole)
        setPermissions(
          resolvedRole === 'admin'
            ? { ...ALL_PERMISSIONS_GRANTED }
            : resolvePermissions(data, resolvedRole)
        )
      } catch (error) {
        console.error('Failed to fetch user role:', error)
        setRole('staff')
        setPermissions(DEFAULT_STAFF_PERMISSIONS)
      } finally {
        setLoading(false)
      }
    })

    return () => unsubscribe()
  }, [])

  const can = (permission: Permission) => permissions[permission] === true

  return {
    role,
    loading,
    isAdmin: role === 'admin',
    isDisabled,
    permissions,
    can,
    // Kept for backwards compatibility with existing call sites
    canViewStockLogs: permissions.canViewStockLogs,
  }
}
