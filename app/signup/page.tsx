'use client'

// Signup route - redirects to /login.
//
// There is deliberately no public sign-up form: accounts are created by an
// administrator from the Users page, which sets the role and permissions at the
// same time. Self-registration would let anyone create a login for the shop.
//
// The route is kept so old links and bookmarks land somewhere sensible.
//
// First account on a fresh database: POST to /api/admin/create-user with
// role 'admin', since there is no administrator yet to create it through the UI.

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

export default function SignupPage() {
  const router = useRouter()
  useEffect(() => { router.replace('/login') }, [router])
  return null
}
