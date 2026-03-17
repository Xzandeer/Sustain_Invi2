import { NextRequest, NextResponse } from 'next/server'
import { collection, doc, getDoc, getDocs, query, runTransaction, serverTimestamp, where } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { getInventoryStatus, parseDateRange, toDate, toNumber } from '@/lib/server/salesInventoryMetrics'

interface SalesPayload {
  itemId?: unknown
  quantity?: unknown
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
    const itemId = typeof body.itemId === 'string' ? body.itemId.trim() : ''
    const soldQuantity = toNumber(body.quantity, Number.NaN)
    const customer =
      typeof body.customer === 'string' && body.customer.trim() ? body.customer.trim() : 'Walk-in Customer'
    const reduceQuantity = body.reduceQuantity !== false

    if (!itemId || !Number.isFinite(soldQuantity) || soldQuantity <= 0) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }

    const inventoryItem = await resolveInventoryItem(itemId)
    if (!inventoryItem) {
      return NextResponse.json({ error: 'Item not found' }, { status: 404 })
    }

    const nowIso = new Date().toISOString()

    const saleRef = doc(collection(db, 'sales'))
    const stockLogRef = doc(collection(db, 'stockLogs'))
    let responseData:
      | {
          id: string
          itemId: string
          items: Array<{
            name: string
            quantity: number
            price: number
            categoryId: string
            status: string
          }>
          totalAmount: number
          createdAt: string
          updatedQuantity: number
          inventoryStatus: string
        }
      | null = null

    await runTransaction(db, async (transaction) => {
      const inventorySnapshot = await transaction.get(inventoryItem.ref)
      if (!inventorySnapshot.exists()) {
        throw new Error('ITEM_NOT_FOUND')
      }

      const latestData = inventorySnapshot.data() as Record<string, unknown>
      const currentQuantity = toNumber(latestData.quantity)
      const minStock = toNumber(latestData.minStock)
      const unitPrice = toNumber(latestData.price)

      if (soldQuantity > currentQuantity) {
        throw new Error('INSUFFICIENT_STOCK')
      }

      const price = unitPrice
      const total = soldQuantity * price

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

      const updatedQuantity = currentQuantity - soldQuantity
      const updatedStatus = getInventoryStatus(updatedQuantity, minStock)

      transaction.set(saleRef, {
        id: saleRef.id,
        itemId: inventoryItem.id,
        items: [
          {
            name: itemName,
            quantity: soldQuantity,
            price,
            categoryId:
              typeof latestData.categoryId === 'string' && latestData.categoryId.trim()
                ? latestData.categoryId.trim()
                : '',
            status: 'completed',
          },
        ],
        categoryName,
        category: categoryName,
        customer,
        totalAmount: total,
        quantity: soldQuantity,
        price,
        total,
        amount: total,
        status: 'completed',
        createdAt: serverTimestamp(),
      })

      if (reduceQuantity) {
        transaction.update(inventoryItem.ref, {
          quantity: updatedQuantity,
          stock: updatedQuantity,
          updatedAt: nowIso,
        })

        transaction.set(stockLogRef, {
          id: stockLogRef.id,
          type: 'sale',
          itemId: inventoryItem.id,
          itemName,
          quantity: soldQuantity * -1,
          createdAt: serverTimestamp(),
        })
      }

      responseData = {
        id: saleRef.id,
        itemId: inventoryItem.id,
        items: [
          {
            name: itemName,
            quantity: soldQuantity,
            price,
            categoryId:
              typeof latestData.categoryId === 'string' && latestData.categoryId.trim()
                ? latestData.categoryId.trim()
                : '',
            status: 'completed',
          },
        ],
        totalAmount: total,
        createdAt: nowIso,
        updatedQuantity: reduceQuantity ? updatedQuantity : currentQuantity,
        inventoryStatus: reduceQuantity ? updatedStatus : getInventoryStatus(currentQuantity, minStock),
      }
    })

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
    }

    console.error('POST /api/sales error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
