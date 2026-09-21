// Client-side trigger for the reservation expiry sweep.
//
// The sweep itself lives in app/api/reservations/expire. It has to: releasing a
// hold writes to `inventory` and `reservations`, and no browser is allowed to
// write either - those writes go through a route that verifies the caller's
// token first. This file only asks the server to run it.

import { apiFetch } from '@/lib/apiFetch'

/**
 * Asks the server to release every hold that has passed its expiry.
 * Safe to call on page load; returns the number released, or 0 on failure.
 */
export async function expireReservations(): Promise<number> {
  try {
    const res = await apiFetch('/api/reservations/expire', { method: 'POST' })
    if (!res.ok) return 0
    const data = (await res.json()) as { expired?: number }
    return typeof data.expired === 'number' ? data.expired : 0
  } catch (error) {
    console.error('expireReservations error:', error)
    return 0
  }
}
