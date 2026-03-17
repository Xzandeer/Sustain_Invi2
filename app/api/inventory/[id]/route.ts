import { NextResponse } from 'next/server'
import { deleteDoc, doc, getDoc, updateDoc } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { getStockStatus, normalizeInventoryCondition, toNumber } from '@/lib/server/salesInventoryMetrics'

interface RouteContext {
  params: Promise<{ id: string }>
}

interface InventoryUpdatePayload {
  name?: unknown
  categoryId?: unknown
  categoryName?: unknown
  category?: unknown
  price?: unknown
  quantity?: unknown
  stock?: unknown
  minStock?: unknown
  status?: unknown
}

export async function PUT(req: Request, context: RouteContext) {
  try {
    const { id } = await context.params
    if (!id) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }

    const snapshot = await getDoc(doc(db, 'inventory', id))
    if (!snapshot.exists()) {
      return NextResponse.json({ error: 'Item not found' }, { status: 404 })
    }

    const body = (await req.json()) as InventoryUpdatePayload
    const current = snapshot.data() as Record<string, unknown>

    const name =
      typeof body.name === 'string' && body.name.trim()
        ? body.name.trim()
        : typeof current.name === 'string'
          ? current.name.trim()
          : ''
    const categoryId =
      typeof body.categoryId === 'string' && body.categoryId.trim()
        ? body.categoryId.trim()
        : typeof current.categoryId === 'string'
          ? current.categoryId.trim()
          : ''
    const categoryName =
      typeof body.categoryName === 'string' && body.categoryName.trim()
        ? body.categoryName.trim()
        : typeof body.category === 'string' && body.category.trim()
          ? body.category.trim()
          : typeof current.categoryName === 'string' && current.categoryName.trim()
            ? current.categoryName.trim()
            : typeof current.category === 'string'
              ? current.category.trim()
              : ''

    const price = toNumber(
      body.price,
      typeof current.price === 'number' || typeof current.price === 'string' ? toNumber(current.price) : Number.NaN
    )
    const quantity = toNumber(
      body.stock ?? body.quantity,
      typeof current.stock === 'number' || typeof current.stock === 'string'
        ? toNumber(current.stock)
        : typeof current.quantity === 'number' || typeof current.quantity === 'string'
          ? toNumber(current.quantity)
        : Number.NaN
    )
    const minStock = toNumber(
      body.minStock,
      typeof current.minStock === 'number' || typeof current.minStock === 'string'
        ? toNumber(current.minStock)
        : Number.NaN
    )

    const condition =
      body.status !== undefined ? normalizeInventoryCondition(body.status) : normalizeInventoryCondition(current.status)

    if (!name || !categoryId || !categoryName) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }

    if (
      !Number.isFinite(price) ||
      !Number.isFinite(quantity) ||
      !Number.isFinite(minStock) ||
      price <= 0 ||
      quantity < 0 ||
      minStock < 0
    ) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }

    const stockStatus = getStockStatus({ stock: quantity, minStock })
    const updatedAt = new Date().toISOString()

    await updateDoc(doc(db, 'inventory', id), {
      name,
      categoryId,
      categoryName,
      category: categoryName,
      price,
      quantity,
      stock: quantity,
      minStock,
      status: condition,
      isDeleted: false,
      deletedAt: null,
      updatedAt,
    })

    return NextResponse.json(
      {
        data: {
          id,
          name,
          categoryId,
          categoryName,
          category: categoryName,
          price,
          quantity,
          stock: quantity,
          minStock,
          status: condition,
          stockStatus,
          isDeleted: false,
          deletedAt: null,
          updatedAt,
        },
      },
      { status: 200 }
    )
  } catch (error) {
    console.error('PUT /api/inventory/[id] error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function DELETE(_: Request, context: RouteContext) {
  try {
    const { id } = await context.params
    if (!id) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }

    const docRef = doc(db, 'inventory', id)
    const snapshot = await getDoc(docRef)
    if (!snapshot.exists()) {
      return NextResponse.json({ error: 'Item not found' }, { status: 404 })
    }

    await updateDoc(docRef, {
      isDeleted: true,
      deletedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    return NextResponse.json({ success: true }, { status: 200 })
  } catch (error) {
    console.error(`DELETE /api/inventory/[id] error:`, error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function PATCH(req: Request, context: RouteContext) {
  try {
    const { id } = await context.params
    if (!id) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }

    const docRef = doc(db, 'inventory', id)
    const snapshot = await getDoc(docRef)
    if (!snapshot.exists()) {
      return NextResponse.json({ error: 'Item not found' }, { status: 404 })
    }

    const body = (await req.json()) as { action?: unknown }
    const action = typeof body.action === 'string' ? body.action : ''

    if (action === 'restore') {
      await updateDoc(docRef, {
        isDeleted: false,
        deletedAt: null,
        updatedAt: new Date().toISOString(),
      })
      return NextResponse.json({ success: true }, { status: 200 })
    }

    if (action === 'permanent-delete') {
      await deleteDoc(docRef)
      return NextResponse.json({ success: true }, { status: 200 })
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  } catch (error) {
    console.error(`PATCH /api/inventory/[id] error:`, error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
