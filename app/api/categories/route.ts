// Product categories.
//
// GET  → all categories, sorted by name
// POST → creates one, rejecting duplicates by exact name (409)
//
// Categories are referenced by inventory items through categoryId, and the
// per-category forecast groups by the same field.

import { NextRequest, NextResponse } from 'next/server'
import { getAdminDb } from '@/lib/firebaseAdmin'
import { requireActiveUserRequest, requireAdminRequest } from '@/lib/server/authorize'

interface CategoryPayload {
  name?: unknown
  requestedByUid?: unknown
}

export async function GET(req: NextRequest) {
  // Read access is checked here, not left to the database rules: this route
  // uses the Admin SDK, which bypasses the rules entirely. Without this line
  // the data below is returned to anyone on the internet who calls the URL.
  const denied = await requireActiveUserRequest(req)
  if (denied) return denied

  try {
    const snapshot = await getAdminDb().collection('categories').orderBy('name', 'asc').get()
    const data = snapshot.docs.map((categoryDoc) => ({
      id: categoryDoc.id,
      ...(categoryDoc.data() as Record<string, unknown>),
    }))

    return NextResponse.json({ data }, { status: 200 })
  } catch (error) {
    console.error('GET /api/categories error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as CategoryPayload

    // Categories are store-wide structure, not day-to-day data - the inventory
    // page already restricts the control to administrators, and this enforces
    // the same rule on the server.
    const denied = await requireAdminRequest(req)
    if (denied) return denied

    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) {
      return NextResponse.json({ error: 'Category name is required.' }, { status: 400 })
    }

    const duplicateSnapshot = await getAdminDb()
      .collection('categories')
      .where('name', '==', name)
      .limit(1)
      .get()
    if (!duplicateSnapshot.empty) {
      return NextResponse.json({ error: 'Category already exists.' }, { status: 409 })
    }

    const createdAt = new Date().toISOString()
    const categoryRef = await getAdminDb().collection('categories').add({
      name,
      createdAt,
    })

    return NextResponse.json(
      {
        data: {
          id: categoryRef.id,
          name,
          createdAt,
        },
      },
      { status: 201 }
    )
  } catch (error) {
    console.error('POST /api/categories error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
