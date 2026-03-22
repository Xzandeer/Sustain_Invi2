'use client'

import { useEffect, useState } from 'react'
import { onAuthStateChanged } from 'firebase/auth'
import { doc, getDoc } from 'firebase/firestore'
import { auth, db } from '@/lib/firebase'

export type UserRole = 'admin' | 'staff'

export const useUserRole = () => {
  const [role, setRole] = useState<UserRole>('staff')
  const [canViewStockLogs, setCanViewStockLogs] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        setRole('staff')
        setCanViewStockLogs(false)
        setLoading(false)
        return
      }

      try {
        const userSnapshot = await getDoc(doc(db, 'users', user.uid))
        const rawRole = userSnapshot.exists() ? userSnapshot.data().role : 'staff'
        const canViewLogs = userSnapshot.exists() ? userSnapshot.data().canViewStockLogs === true : false
        setRole(rawRole === 'admin' ? 'admin' : 'staff')
        setCanViewStockLogs(canViewLogs || rawRole === 'admin')
      } catch (error) {
        console.error('Failed to fetch user role:', error)
        setRole('staff')
        setCanViewStockLogs(false)
      } finally {
        setLoading(false)
      }
    })

    return () => unsubscribe()
  }, [])

  return { role, loading, isAdmin: role === 'admin', canViewStockLogs }
}
