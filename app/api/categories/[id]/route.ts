// Deletes a single category.
//
// DELETE → removes the category, but only if no inventory item still points
//          at it. Deleting a category that is still in use would leave those
//          items with a dangling categoryId, so we return 409 instead.
//
// To remove a category that is in use: move its items to another category first.

import { NextResponse } from 'next/server'
import { collection, deleteDoc, doc, getDoc, getDocs, limit, query, where } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { requireAdmin } from '@/lib/server/authorize'

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function DELETE(req: Request, context: RouteContext) {
  try {
    const { id } = await context.params
    if (!id) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }

    // Administrator only, matching the create route. The uid travels in the
    // request body rather than the URL so it stays out of server access logs.
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const denied = await requireAdmin(body.requestedByUid)
    if (denied) return denied

    const categoryRef = doc(db, 'categories', id)
    const categorySnapshot = await getDoc(categoryRef)
    if (!categorySnapshot.exists()) {
      return NextResponse.json({ error: 'Category not found' }, { status: 404 })
    }

    const linkedInventoryQuery = query(
      collection(db, 'inventory'),
      where('categoryId', '==', id),
      limit(1)
    )
    const linkedInventorySnapshot = await getDocs(linkedInventoryQuery)
    if (!linkedInventorySnapshot.empty) {
      return NextResponse.json(
        { error: 'Cannot delete category linked to inventory items.' },
        { status: 409 }
      )
    }

    await deleteDoc(categoryRef)
    return NextResponse.json({ success: true }, { status: 200 })
  } catch (error) {
    console.error('DELETE /api/categories/[id] error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
