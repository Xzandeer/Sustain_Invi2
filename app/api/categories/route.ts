import { NextRequest, NextResponse } from 'next/server'
import { addDoc, collection, getDocs, limit, orderBy, query, where } from 'firebase/firestore'
import { db } from '@/lib/firebase'

interface CategoryPayload {
  name?: unknown
}

export async function GET() {
  try {
    const categoriesQuery = query(collection(db, 'categories'), orderBy('name', 'asc'))
    const snapshot = await getDocs(categoriesQuery)
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
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) {
      return NextResponse.json({ error: 'Category name is required.' }, { status: 400 })
    }

    const duplicateQuery = query(collection(db, 'categories'), where('name', '==', name), limit(1))
    const duplicateSnapshot = await getDocs(duplicateQuery)
    if (!duplicateSnapshot.empty) {
      return NextResponse.json({ error: 'Category already exists.' }, { status: 409 })
    }

    const createdAt = new Date().toISOString()
    const categoryRef = await addDoc(collection(db, 'categories'), {
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
