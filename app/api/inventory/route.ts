import { NextRequest, NextResponse } from 'next/server'
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  runTransaction,
  updateDoc,
  where,
} from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { getStockStatus, normalizeInventoryCondition, toNumber } from '@/lib/server/salesInventoryMetrics'

interface InventoryPayload {
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

export async function GET(req: NextRequest) {
  try {
    const view = new URL(req.url).searchParams.get('view')
    const inventoryQuery = query(collection(db, 'inventory'), orderBy('createdAt', 'desc'))
    const [inventorySnapshot, categoriesSnapshot] = await Promise.all([
      getDocs(inventoryQuery),
      getDocs(collection(db, 'categories')),
    ])

    const categoriesById = new Map(
      categoriesSnapshot.docs.map((categoryDoc) => {
        const data = categoryDoc.data() as Record<string, unknown>
        const name = typeof data.name === 'string' ? data.name.trim() : ''
        return [categoryDoc.id, name]
      })
    )

    const items = inventorySnapshot.docs
      .map((itemDoc) => {
      const data = itemDoc.data() as Record<string, unknown>
      const categoryId = typeof data.categoryId === 'string' ? data.categoryId : ''
      const categoryNameFromLookup = categoryId ? categoriesById.get(categoryId) : ''
      const categoryName =
        (typeof data.categoryName === 'string' && data.categoryName.trim()) ||
        categoryNameFromLookup ||
        (typeof data.category === 'string' ? data.category.trim() : '') ||
        'Uncategorized'

      return {
        id: itemDoc.id,
        ...data,
        categoryId,
        categoryName,
        category: categoryName,
        quantity: toNumber(data.stock ?? data.quantity, 0),
        stock: toNumber(data.stock ?? data.quantity, 0),
        reservedStock: toNumber(data.reservedStock, 0),
        minStock: toNumber(data.minStock, 0),
        status: normalizeInventoryCondition(data.status),
        stockStatus: getStockStatus(data),
        isDeleted: data.isDeleted === true,
      }
      })
      .filter((item) => (view === 'trash' ? item.isDeleted === true : item.isDeleted !== true))

    return NextResponse.json({ data: items }, { status: 200 })
  } catch (error) {
    console.error('GET /api/inventory error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as InventoryPayload
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    const categoryIdInput = typeof body.categoryId === 'string' ? body.categoryId.trim() : ''
    const categoryNameInput =
      typeof body.categoryName === 'string'
        ? body.categoryName.trim()
        : typeof body.category === 'string'
          ? body.category.trim()
          : ''
    const price = toNumber(body.price, Number.NaN)
    const quantity = toNumber(body.stock ?? body.quantity, Number.NaN)
    const minStock = toNumber(body.minStock, Number.NaN)
    const condition = normalizeInventoryCondition(body.status)

    if (!name) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }

    if (![price, quantity, minStock].every((value) => Number.isFinite(value))) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }

    if (price <= 0 || quantity < 0 || minStock < 0) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }

    let categoryId = categoryIdInput
    let categoryName = categoryNameInput

    if (categoryId) {
      const categorySnapshot = await getDoc(doc(db, 'categories', categoryId))
      if (!categorySnapshot.exists()) {
        return NextResponse.json({ error: 'Category not found' }, { status: 404 })
      }

      const categoryData = categorySnapshot.data() as Record<string, unknown>
      categoryName =
        typeof categoryData.name === 'string' && categoryData.name.trim() ? categoryData.name.trim() : categoryName
    } else if (categoryName) {
      const categoryQuery = query(collection(db, 'categories'), where('name', '==', categoryName))
      const categorySnapshot = await getDocs(categoryQuery)
      if (!categorySnapshot.empty) {
        const matchedCategory = categorySnapshot.docs[0]
        categoryId = matchedCategory.id
        const categoryData = matchedCategory.data() as Record<string, unknown>
        categoryName =
          typeof categoryData.name === 'string' && categoryData.name.trim()
            ? categoryData.name.trim()
            : categoryName
      } else {
        const createdCategoryRef = await addDoc(collection(db, 'categories'), {
          name: categoryName,
          createdAt: new Date().toISOString(),
        })
        categoryId = createdCategoryRef.id
      }
    }

    if (!categoryId || !categoryName) {
      return NextResponse.json({ error: 'Invalid category' }, { status: 400 })
    }

    const duplicateQuery = query(collection(db, 'inventory'), where('name', '==', name), where('categoryId', '==', categoryId))
    const duplicateSnapshot = await getDocs(duplicateQuery)
    const existingDoc =
      duplicateSnapshot.docs.find((docItem) => {
        const data = docItem.data() as Record<string, unknown>
        return data.isDeleted !== true && normalizeInventoryCondition(data.status) === condition
      }) ?? null

    if (existingDoc) {
      const now = new Date().toISOString()
      let responseData: Record<string, unknown> | null = null

      await runTransaction(db, async (transaction) => {
        const latestSnapshot = await transaction.get(existingDoc.ref)
        if (!latestSnapshot.exists()) {
          throw new Error('INVENTORY_ITEM_NOT_FOUND')
        }

        const existingData = latestSnapshot.data() as Record<string, unknown>
        const currentQuantity = toNumber(existingData.stock ?? existingData.quantity, 0)
        const existingMinStock = toNumber(existingData.minStock, minStock)
        const updatedQuantity = currentQuantity + quantity
        const stockStatus = getStockStatus({ stock: updatedQuantity, minStock: existingMinStock })

        transaction.update(existingDoc.ref, {
          price,
          quantity: updatedQuantity,
          stock: updatedQuantity,
          reservedStock: toNumber(existingData.reservedStock, 0),
          status: condition,
          isDeleted: false,
          deletedAt: null,
          updatedAt: now,
        })

        responseData = {
          id:
            typeof existingData.id === 'string' && existingData.id.trim()
              ? existingData.id
              : latestSnapshot.id,
          ...existingData,
          categoryId,
          categoryName,
          category: categoryName,
          price,
          quantity: updatedQuantity,
          stock: updatedQuantity,
          reservedStock: toNumber(existingData.reservedStock, 0),
          minStock: existingMinStock,
          status: condition,
          stockStatus,
          isDeleted: false,
          deletedAt: null,
          updatedAt: now,
        }
      })

      return NextResponse.json(
        {
          data: responseData,
          message: 'Existing inventory item quantity updated.',
        },
        { status: 200 }
      )
    }

    const now = new Date().toISOString()
    const stockStatus = getStockStatus({ stock: quantity, minStock })

    const docRef = await addDoc(collection(db, 'inventory'), {
      name,
      categoryId,
      categoryName,
      category: categoryName,
      price,
      quantity,
      stock: quantity,
      reservedStock: 0,
      minStock,
      status: condition,
      isDeleted: false,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    })

    await updateDoc(docRef, { id: docRef.id })

    return NextResponse.json(
      {
        data: {
          id: docRef.id,
          name,
          categoryId,
          categoryName,
          category: categoryName,
          price,
          quantity,
          stock: quantity,
          reservedStock: 0,
          minStock,
          status: condition,
          stockStatus,
          isDeleted: false,
          deletedAt: null,
          createdAt: now,
          updatedAt: now,
        },
      },
      { status: 201 }
    )
  } catch (error) {
    console.error('POST /api/inventory error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
