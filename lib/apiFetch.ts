// Browser-side fetch wrapper that proves who is calling.
//
// API routes used to take the caller's uid from the request body and trust it.
// A uid is not a secret - it is stored on every sale and stock log - so anyone
// who read one could send the owner's uid and be treated as the administrator.
//
// This attaches the signed-in user's Firebase ID token instead. The server
// verifies the token's signature and reads the uid from inside it, so the
// caller cannot claim to be someone else.

import { auth } from '@/lib/firebase'

export async function apiFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const headers = new Headers(init.headers)

  const user = auth.currentUser
  if (user) {
    try {
      headers.set('Authorization', `Bearer ${await user.getIdToken()}`)
    } catch {
      // Token refresh failed - send the request unauthenticated and let the
      // server reject it, rather than failing silently here.
    }
  }

  return fetch(input, { ...init, headers })
}
