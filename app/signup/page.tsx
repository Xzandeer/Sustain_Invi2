'use client'

// Signup page.
//
// Note: staff accounts are normally created by an admin from the Users page,
// which sets the role and permissions at the same time. This route exists for
// the first account and for testing.

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

export default function SignupPage() {
  const router = useRouter()
  useEffect(() => { router.replace('/login') }, [router])
  return null
}
