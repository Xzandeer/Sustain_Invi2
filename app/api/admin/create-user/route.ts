// Creates a staff or administrator account.
//
// POST → creates the Firebase Auth user, then writes the matching profile
//        document in the `users` collection. Both must exist: Auth handles
//        the password, Firestore holds the role and permissions.
//
// New accounts start with canViewStockLogs = false. The admin grants the rest
// from Users → Permissions after the account is created.
//
// Note: this uses the Admin SDK so the current admin is NOT signed out. Using
// the client SDK to create a user would switch the active session to the new
// account, which is why this lives on the server.

import { NextRequest, NextResponse } from 'next/server'
import { getApps, initializeApp, cert, getApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getAdminDb } from '@/lib/firebaseAdmin'
import { noAdminExists, requireAdmin } from '@/lib/server/authorize'

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
    const body = (await req.json()) as {
      name: string
      email: string
      password: string
      role: 'admin' | 'staff'
      requestedByUid?: string
    }
    const { name, email, password, role } = body

    // Creating accounts is an administrator action.
    //
    // The exception is a database with no administrator in it yet: the first
    // admin has to be created by someone who is not one. That window closes the
    // moment the first admin exists, so it cannot be used to grant yourself
    // access to a running shop.
    if (!(await noAdminExists())) {
      const denied = await requireAdmin(body.requestedByUid)
      if (denied) return denied
    }

    if (!name?.trim() || !email?.trim() || !password || !role) {
      return NextResponse.json({ error: 'All fields are required.' }, { status: 400 })
    }
    if (password.length < 6) {
      return NextResponse.json({ error: 'Password must be at least 6 characters.' }, { status: 400 })
    }

    const adminAuth = getAdminAuth()
    const userRecord = await adminAuth.createUser({ email: email.trim(), password, displayName: name.trim() })

    const adminDb = getAdminDb()
    await adminDb.collection('users').doc(userRecord.uid).set({
      name: name.trim(),
      email: email.trim().toLowerCase(),
      role,
      canViewStockLogs: false,
      createdAt: new Date().toISOString(),
    })

    return NextResponse.json({ success: true, uid: userRecord.uid })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to create user.'
    const isEmailTaken = msg.includes('email-already-exists') || msg.includes('EMAIL_EXISTS')
    return NextResponse.json(
      { error: isEmailTaken ? 'An account with that email already exists.' : msg },
      { status: 400 }
    )
  }
}
