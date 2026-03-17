import { NextResponse } from 'next/server'
import { collection, deleteDoc, doc, getDoc, getDocs, limit, query, where } from 'firebase/firestore'
import { db } from '@/lib/firebase'

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function DELETE(_: Request, context: RouteContext) {
  try {
    const { id } = await context.params
    if (!id) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }

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
