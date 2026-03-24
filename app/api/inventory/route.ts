import { NextRequest, NextResponse } from 'next/server'
import {
  collection,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  updateDoc,
  where,
} from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { getStockStatus, normalizeInventoryCondition, toNumber } from '@/lib/server/salesInventoryMetrics'
import { createInventoryVariant, createStockLog, findInventoryVariant, getProcessedByInfo } from '@/lib/server/inventory'

interface InventoryPayload {
  name?: unknown
  categoryId?: unknown
  categoryName?: unknown
  category?: unknown
  description?: unknown
  imageUrl?: unknown
  price?: unknown
  quantity?: unknown
  stock?: unknown
  minStock?: unknown
  status?: unknown
  processedBy?: unknown
  remarks?: unknown
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
        condition: normalizeInventoryCondition(data.condition),
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
    const condition = normalizeInventoryCondition(body.condition)
    const description = typeof body.description === 'string' ? body.description.trim() : ''
    const imageUrl = typeof body.imageUrl === 'string' ? body.imageUrl.trim() : ''
    const processedBy = await getProcessedByInfo(body.processedBy)
    const remarks = typeof body.remarks === 'string' ? body.remarks.trim() : ''

    if (!name) {
      return NextResponse.json({ error: 'Item name is required.' }, { status: 400 })
    }

    if (![price, quantity, minStock].every((value) => Number.isFinite(value))) {
      return NextResponse.json({ error: 'Price, quantity, and minimum stock are required.' }, { status: 400 })
    }

    if (price <= 0 || quantity < 0 || minStock < 0) {
      return NextResponse.json({ error: 'Price must be greater than zero, and stock values cannot be negative.' }, { status: 400 })
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
        return NextResponse.json({ error: 'Category not found' }, { status: 404 })
      }
    }

    if (!categoryId || !categoryName) {
      return NextResponse.json({ error: 'Invalid category' }, { status: 400 })
    }

    const existingVariant = await findInventoryVariant({ name, categoryId, condition })

    if (existingVariant) {
      const now = new Date().toISOString()
      const updatedQuantity = existingVariant.stock + quantity
      const stockStatus = getStockStatus({ stock: updatedQuantity, minStock: existingVariant.minStock })

      await updateDoc(existingVariant.ref, {
        price,
        quantity: updatedQuantity,
        stock: updatedQuantity,
        reservedStock: existingVariant.reservedStock,
        minStock: existingVariant.minStock,
        condition: condition,
        categoryName,
        category: categoryName,
        description,
        imageUrl,
        isDeleted: false,
        deletedAt: null,
        updatedAt: now,
      })

      await createStockLog({
        actionType: 'stock_increased',
        itemId: existingVariant.id,
        itemName: existingVariant.name,
        condition,
        quantityBefore: existingVariant.stock,
        quantityChanged: quantity,
        quantityAfter: updatedQuantity,
        stockBefore: existingVariant.stock,
        stockAfter: updatedQuantity,
        reservedBefore: existingVariant.reservedStock,
        reservedAfter: existingVariant.reservedStock,
        user: processedBy,
        remarks: remarks || 'Inventory stock increased from add item flow.',
      })

      return NextResponse.json(
        {
          data: {
            id: existingVariant.id,
            name: existingVariant.name,
            categoryId,
            categoryName,
            category: categoryName,
            price,
            quantity: updatedQuantity,
            stock: updatedQuantity,
            reservedStock: existingVariant.reservedStock,
            minStock: existingVariant.minStock,
            condition: condition,
            description,
            imageUrl,
            stockStatus,
            isDeleted: false,
            deletedAt: null,
            updatedAt: now,
          },
          message: 'Existing inventory item quantity updated.',
        },
        { status: 200 }
      )
    }

    const created = await createInventoryVariant({
      name,
      categoryId,
      categoryName,
      price,
      quantity,
      minStock,
      condition,
      description,
      imageUrl,
    })

    await createStockLog({
      actionType: 'item_added',
      itemId: created.id,
      itemName: name,
      condition,
      quantityBefore: 0,
      quantityChanged: quantity,
      quantityAfter: quantity,
      user: processedBy,
      remarks: remarks || 'New inventory variant created.',
    })

    return NextResponse.json(
      {
        data: {
          id: created.id,
          name,
          categoryId,
          categoryName,
          category: categoryName,
          price,
          quantity,
          stock: quantity,
          reservedStock: 0,
          minStock,
          condition: condition,
          description,
          imageUrl,
          stockStatus: created.stockStatus,
          isDeleted: false,
          deletedAt: null,
          createdAt: created.now,
          updatedAt: created.now,
        },
      },
      { status: 201 }
    )
  } catch (error) {
    console.error('POST /api/inventory error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
