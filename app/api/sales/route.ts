import { NextRequest, NextResponse } from 'next/server'
import { addDoc, collection, doc, getDoc, getDocs, query, runTransaction, serverTimestamp, where } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { parseDateRange, toDate, toNumber } from '@/lib/server/salesInventoryMetrics'

interface SalesPayload {
  itemId?: unknown
  quantity?: unknown
  items?: unknown
  customer?: unknown
  reduceQuantity?: unknown
}

const resolveInventoryItem = async (itemId: string) => {
  const directRef = doc(db, 'inventory', itemId)
  const directSnapshot = await getDoc(directRef)
  if (directSnapshot.exists()) {
    const directData = directSnapshot.data() as Record<string, unknown>
    if (directData.isDeleted === true) {
      return null
    }
    return {
      id: directSnapshot.id,
      ref: directRef,
      data: directData,
    }
  }

  const fallbackQuery = query(collection(db, 'inventory'), where('id', '==', itemId))
  const fallbackSnapshot = await getDocs(fallbackQuery)
  if (fallbackSnapshot.empty) return null

  const firstDoc = fallbackSnapshot.docs[0]
  const firstData = firstDoc.data() as Record<string, unknown>
  if (firstData.isDeleted === true) return null
  return {
    id: firstDoc.id,
    ref: doc(db, 'inventory', firstDoc.id),
    data: firstData,
  }
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const startDate = searchParams.get('startDate')
    const endDate = searchParams.get('endDate')
    const categoryName = searchParams.get('category')

    const range = parseDateRange(startDate, endDate)
    if ('error' in range) {
      return NextResponse.json({ error: range.error }, { status: 400 })
    }

    const snapshot = await getDocs(collection(db, 'sales'))

    let records: Array<Record<string, unknown> & { id: string }> = snapshot.docs.map((saleDoc) => ({
      ...(saleDoc.data() as Record<string, unknown>),
      id: saleDoc.id,
    }))

    if (categoryName && categoryName !== 'all') {
      records = records.filter((record) => record.categoryName === categoryName || record.category === categoryName)
    }

    if (range.start || range.end) {
      records = records.filter((record) => {
        const recordDate = toDate(record.createdAt)
        if (!recordDate) return false
        if (range.start && recordDate < range.start) return false
        if (range.end && recordDate > range.end) return false
        return true
      })
    }

    records.sort((a, b) => {
      const aDate = toDate(a.createdAt)?.getTime() ?? 0
      const bDate = toDate(b.createdAt)?.getTime() ?? 0
      return bDate - aDate
    })

    return NextResponse.json({ data: records }, { status: 200 })
  } catch (error) {
    console.error('GET /api/sales error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as SalesPayload
    const customer =
      typeof body.customer === 'string' && body.customer.trim() ? body.customer.trim() : 'Walk-in Customer'
    const reduceQuantity = body.reduceQuantity !== false
    const payloadItems = Array.isArray(body.items)
      ? body.items
      : typeof body.itemId === 'string'
        ? [{ itemId: body.itemId, quantity: body.quantity }]
        : []

    const normalizedItems = payloadItems
      .map((item) => {
        const record = item as Record<string, unknown>
        const itemId = typeof record.itemId === 'string' ? record.itemId.trim() : ''
        const quantity = Math.floor(toNumber(record.quantity, Number.NaN))
        return { itemId, quantity }
      })
      .filter((item) => item.itemId && Number.isFinite(item.quantity) && item.quantity > 0)

    if (normalizedItems.length === 0) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }

    const nowIso = new Date().toISOString()

    let responseData:
      | {
          id: string
          items: Array<{
            itemId: string
            name: string
            quantity: number
            price: number
            categoryId: string
            status: string
          }>
          totalAmount: number
          createdAt: string
        }
      | null = null

    const resolvedItems = await Promise.all(
      normalizedItems.map(async (requestedItem) => {
        const inventoryItem = await resolveInventoryItem(requestedItem.itemId)
        if (!inventoryItem) {
          throw new Error('ITEM_NOT_FOUND')
        }
        return {
          requestedItem,
          inventoryItem,
        }
      })
    )

    const preparedItems: Array<{
      ref: ReturnType<typeof doc>
      itemId: string
      itemName: string
      quantity: number
      price: number
      categoryId: string
      categoryName: string
      newStock: number
    }> = []

    await runTransaction(db, async (transaction) => {
      const pendingUpdates: Array<{
        ref: ReturnType<typeof doc>
        itemId: string
        itemName: string
        quantity: number
        price: number
        categoryId: string
        categoryName: string
        newStock: number
      }> = []

      for (const { requestedItem, inventoryItem } of resolvedItems) {
        const inventorySnapshot = await transaction.get(inventoryItem.ref)
        if (!inventorySnapshot.exists()) {
          throw new Error('ITEM_NOT_FOUND')
        }

        const latestData = inventorySnapshot.data() as Record<string, unknown>
        const currentQuantity = toNumber(latestData.stock ?? latestData.quantity)
        const currentReservedStock = toNumber(latestData.reservedStock, 0)
        const availableStock = Math.max(0, currentQuantity - currentReservedStock)
        const unitPrice = toNumber(latestData.price)

        if (requestedItem.quantity > availableStock) {
          throw new Error('INSUFFICIENT_STOCK')
        }

        const itemName =
          typeof latestData.name === 'string' && latestData.name.trim()
            ? latestData.name.trim()
            : 'Unnamed Item'

        const categoryName =
          typeof latestData.categoryName === 'string' && latestData.categoryName.trim()
            ? latestData.categoryName.trim()
            : typeof latestData.category === 'string' && latestData.category.trim()
              ? latestData.category.trim()
              : 'Uncategorized'

        pendingUpdates.push({
          ref: inventoryItem.ref,
          itemId: inventoryItem.id,
          itemName,
          quantity: requestedItem.quantity,
          price: unitPrice,
          categoryId:
            typeof latestData.categoryId === 'string' && latestData.categoryId.trim()
              ? latestData.categoryId.trim()
              : '',
          categoryName,
          newStock: currentQuantity - requestedItem.quantity,
        })
      }

      if (reduceQuantity) {
        for (const pendingUpdate of pendingUpdates) {
          transaction.update(pendingUpdate.ref, {
            quantity: pendingUpdate.newStock,
            stock: pendingUpdate.newStock,
            updatedAt: nowIso,
          })
        }
      }

      preparedItems.push(...pendingUpdates)
    })

    const saleItems = preparedItems.map((item) => ({
      itemId: item.itemId,
      name: item.itemName,
      quantity: item.quantity,
      price: item.price,
      categoryId: item.categoryId,
      categoryName: item.categoryName,
      status: 'completed',
    }))

    const totalAmount = saleItems.reduce((sum, item) => sum + item.quantity * item.price, 0)
    const categoryNames = Array.from(new Set(saleItems.map((item) => item.categoryName)))

    const saleDoc = await addDoc(collection(db, 'sales'), {
      ...(saleItems.length === 1 ? { itemId: saleItems[0].itemId } : {}),
      items: saleItems,
      categoryName: categoryNames.join(', '),
      category: categoryNames.join(', '),
      customer,
      totalAmount,
      quantity: saleItems.reduce((sum, item) => sum + item.quantity, 0),
      total: totalAmount,
      amount: totalAmount,
      status: 'Completed',
      createdAt: serverTimestamp(),
    })

    if (preparedItems.length > 0) {
      await Promise.all(
        preparedItems.map((item) =>
          addDoc(collection(db, 'stockLogs'), {
            type: 'sale',
            itemId: item.itemId,
            itemName: item.itemName,
            quantity: item.quantity * -1,
            createdAt: serverTimestamp(),
          })
        )
      )
    }

    responseData = {
      id: saleDoc.id,
      items: saleItems,
      totalAmount,
      createdAt: nowIso,
    }

    if (!responseData) {
      throw new Error('FAILED_TO_CREATE_SALE')
    }

    return NextResponse.json({ data: responseData }, { status: 201 })
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === 'INSUFFICIENT_STOCK') {
        return NextResponse.json({ error: 'Cannot sell more than available stock' }, { status: 400 })
      }

      if (error.message === 'ITEM_NOT_FOUND') {
        return NextResponse.json({ error: 'Item not found' }, { status: 404 })
      }

      console.error('SALE ERROR:', error)
      return NextResponse.json({ error: error.message || 'Server error' }, { status: 500 })
    }

    console.error('SALE ERROR:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
