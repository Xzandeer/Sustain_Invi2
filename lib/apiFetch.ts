// Browser-side fetch wrapper that proves who is calling.
//
// API routes used to take the caller's uid from the request body and trust it.
// A uid is not a secret - it is stored on every sale and stock log - so anyone
// who read one could send the owner's uid and be treated as the administrator.
//
// This attaches the signed-in user's Firebase ID token instead. The server
// verifies the token's signature and reads the uid from inside it, so the
// caller cannot claim to be someone else.
//
// TIMING
// Firebase restores the session asynchronously. On a fresh page load
// auth.currentUser is still null for the first moment, so a request fired
// while the page mounts would go out unauthenticated and come back 401.
// authStateReady() resolves once that restore has finished, whether or not
// anyone is signed in.

import { auth } from '@/lib/firebase'

export async function apiFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const headers = new Headers(init.headers)

  try {
    await auth.authStateReady()
    const user = auth.currentUser
    if (user) {
      headers.set('Authorization', `Bearer ${await user.getIdToken()}`)
    }
  } catch {
    // Could not obtain a token - send the request anyway and let the server
    // reject it, rather than failing silently on the client.
  }

  return fetch(input, { ...init, headers })
}
