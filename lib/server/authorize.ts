// Server-side permission enforcement.
//
// The UI hides controls a user lacks permission for, but that is only a
// convenience — a request can still be crafted by hand. API routes that perform
// privileged actions call requirePermission() so the rule is enforced on the
// server as well.

import { doc, getDoc } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { Permission, resolvePermissions } from '@/lib/auth/permissions'

export interface AuthzResult {
  allowed: boolean
  reason?: string
  role?: 'admin' | 'staff'
}

/**
 * Checks whether the given user may perform an action.
 * Also rejects disabled accounts outright.
 */
export async function checkPermission(
  uid: string | undefined | null,
  permission: Permission
): Promise<AuthzResult> {
  if (!uid) {
    return { allowed: false, reason: 'Not signed in.' }
  }

  try {
    const snap = await getDoc(doc(db, 'users', uid))
    if (!snap.exists()) {
      return { allowed: false, reason: 'User account not found.' }
    }

    const data = snap.data() as Record<string, unknown>

    if (data.isDisabled === true) {
      return { allowed: false, reason: 'This account has been disabled.' }
    }

    const role: 'admin' | 'staff' = data.role === 'admin' ? 'admin' : 'staff'
    if (role === 'admin') return { allowed: true, role }

    const perms = resolvePermissions(data, role)
    if (perms[permission]) return { allowed: true, role }

    return {
      allowed: false,
      role,
      reason: 'Your account does not have permission to perform this action.',
    }
  } catch {
    // Fail closed — if we cannot verify, deny.
    return { allowed: false, reason: 'Unable to verify permissions.' }
  }
}
