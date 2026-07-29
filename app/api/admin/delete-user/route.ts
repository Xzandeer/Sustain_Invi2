// Permanently deletes a user account.
//
// Removes the Firebase Auth user and their Firestore profile document.
// Sales, stock logs and reservations they created are NOT touched — those
// records keep the processedBy name/email that was captured at the time, so
// the audit trail stays intact after the account is gone.
//
// Guards:
//   • Requester must be an administrator
//   • Cannot delete your own account
//   • Cannot delete the last remaining administrator
//   • Requester must type CONFIRM

import { NextRequest, NextResponse } from 'next/server'
import { getApps, initializeApp, cert, getApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getAdminDb } from '@/lib/firebaseAdmin'

function getAdminAuth() {
  const privateKey = process.env.FIREBASE_ADMIN_PRIVATE_KEY
  const clientEmail = process.env.FIREBASE_ADMIN_CLIENT_EMAIL
  const projectId = process.env.FIREBASE_ADMIN_PROJECT_ID ?? 'sustain-inventory'

  if (!privateKey || !clientEmail) {
    throw new Error('Missing Firebase Admin credentials.')
  }

  const normalizedKey = privateKey.includes('\\n')
    ? privateKey.replace(/\\n/g, '\n')
    : privateKey

  const app = getApps().length
    ? getApp()
    : initializeApp({ credential: cert({ projectId, clientEmail, privateKey: normalizedKey }) })

  return getAuth(app)
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const targetUid = typeof body.targetUid === 'string' ? body.targetUid.trim() : ''
    const requestedByUid =
      typeof body.requestedByUid === 'string' ? body.requestedByUid.trim() : ''
    const confirmText =
      typeof body.confirmText === 'string' ? body.confirmText.trim().toUpperCase() : ''

    if (!targetUid || !requestedByUid) {
      return NextResponse.json({ error: 'Missing required information.' }, { status: 400 })
    }

    if (targetUid === requestedByUid) {
      return NextResponse.json(
        { error: 'You cannot delete your own account.' },
        { status: 400 }
      )
    }

    const adminDb = getAdminDb()

    // Requester must be an admin
    const requesterSnap = await adminDb.collection('users').doc(requestedByUid).get()
    if (!requesterSnap.exists || requesterSnap.data()?.role !== 'admin') {
      return NextResponse.json(
        { error: 'Only an administrator can delete accounts.' },
        { status: 403 }
      )
    }

    // Target must exist
    const targetSnap = await adminDb.collection('users').doc(targetUid).get()
    if (!targetSnap.exists) {
      return NextResponse.json({ error: 'That account no longer exists.' }, { status: 404 })
    }

    const target = targetSnap.data() as Record<string, unknown>
    const targetEmail = String(target.email ?? '').toLowerCase()

    // Typed confirmation must match
    if (confirmText !== 'CONFIRM') {
      return NextResponse.json(
        { error: 'Type CONFIRM to delete this account.' },
        { status: 400 }
      )
    }

    // Never remove the last administrator
    if (target.role === 'admin') {
      const admins = await adminDb.collection('users').where('role', '==', 'admin').get()
      const otherActiveAdmins = admins.docs.filter(
        (d) => d.id !== targetUid && d.data()?.isDisabled !== true
      )
      if (otherActiveAdmins.length === 0) {
        return NextResponse.json(
          { error: 'You cannot delete the last administrator account.' },
          { status: 400 }
        )
      }
    }

    // Delete the auth user first, then the profile document
    try {
      await getAdminAuth().deleteUser(targetUid)
    } catch (err) {
      const msg = err instanceof Error ? err.message : ''
      // If the auth record is already gone, continue and clean up Firestore
      if (!msg.includes('user-not-found')) throw err
    }

    await adminDb.collection('users').doc(targetUid).delete()

    return NextResponse.json({ success: true, deletedEmail: targetEmail })
  } catch (err) {
    console.error('[delete-user] Error:', err)
    const msg = err instanceof Error ? err.message : 'Failed to delete the account.'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
