// Inventory API endpoint - GET to list items, POST to create items
import { NextRequest, NextResponse } from 'next/server'
import { MAX_STOCK, cleanConditionNotes, INPUT_LIMITS } from '@/lib/constants/limits'
import { getAdminDb } from '@/lib/firebaseAdmin'
import { getStockStatus, normalizeInventoryCondition, toNumber } from '@/lib/server/salesInventoryMetrics'
import { createInventoryVariant, createStockLog, findInventoryVariant, getProcessedByInfo } from '@/lib/server/inventory'
import { guardRequest, requireActiveUserRequest } from '@/lib/server/authorize'
import { normalizeTrackingMode, normalizeUnitGrade, type UnitDetails } from '@/lib/inventory/units'
import { allocateUnitCodes, describeUnits, writeNewUnits } from '@/lib/server/units'

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
  condition?: unknown
  isSingleItem?: unknown
  conditionNotes?: unknown
  processedBy?: unknown
  remarks?: unknown
  /** 'unit' (default) or 'quantity' - see lib/inventory/units.ts. New items only. */
  trackingMode?: unknown
  /** Grade, notes and optional own price for the pieces being added. */
  unitGrade?: unknown
  unitNotes?: unknown
  unitPrice?: unknown
}

// GET /api/inventory - List inventory items (optionally filtered to show trash)
export async function GET(req: NextRequest) {
  // Read access is checked here, not left to the database rules: this route
  // uses the Admin SDK, which bypasses the rules entirely. Without this line
  // the data below is returned to anyone on the internet who calls the URL.
  const denied = await requireActiveUserRequest(req)
  if (denied) return denied

  try {
    // Step 1: Parse view parameter (default: active items, 'trash': deleted items)
    const view = new URL(req.url).searchParams.get('view')
    const adminDb = getAdminDb()

    // Step 2: Fetch inventory and categories in parallel
    const [inventorySnapshot, categoriesSnapshot] = await Promise.all([
      adminDb.collection('inventory').orderBy('createdAt', 'desc').get(),
      adminDb.collection('categories').get(),
    ])

    // Step 3: Build category lookup map (categoryId -> categoryName)
    const categoriesById = new Map(
      categoriesSnapshot.docs.map((categoryDoc) => {
        const data = categoryDoc.data() as Record<string, unknown>
        const name = typeof data.name === 'string' ? data.name.trim() : ''
        return [categoryDoc.id, name]
      })
    )

    // Step 4: Format inventory items with all required fields
    const items = inventorySnapshot.docs
      .map((itemDoc) => {
      const data = itemDoc.data() as Record<string, unknown>
      const categoryId = typeof data.categoryId === 'string' ? data.categoryId : ''
      const categoryNameFromLookup = categoryId ? categoriesById.get(categoryId) : ''
      // Try multiple fields for category name
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
      // Step 5: Filter by view (show trash or active items)
      .filter((item) => (view === 'trash' ? item.isDeleted === true : item.isDeleted !== true))

    return NextResponse.json({ data: items }, { status: 200 })
  } catch (error) {
    console.error('GET /api/inventory error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

// POST /api/inventory - Create new item or increment existing variant
export async function POST(req: NextRequest) {
  try {
    // Step 1: Parse and validate request body
    const body = (await req.json()) as InventoryPayload
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, INPUT_LIMITS.name) : ''
    const categoryIdInput = typeof body.categoryId === 'string' ? body.categoryId.trim() : ''
    const categoryNameInput =
      typeof body.categoryName === 'string'
        ? body.categoryName.trim()
        : typeof body.category === 'string'
          ? body.category.trim()
          : ''
    const price = toNumber(body.price, Number.NaN)
    // A single item is one physical unit with its own record. The quantity and
    // minimum are fixed here rather than trusted from the request, so a single
    // item can never be created holding 5 units.
    const isSingleItem = body.isSingleItem === true
    const quantity = isSingleItem ? 1 : toNumber(body.stock ?? body.quantity, Number.NaN)
    const minStock = isSingleItem ? 0 : toNumber(body.minStock, Number.NaN)
    const conditionNotes = cleanConditionNotes(body.conditionNotes)
    const condition = normalizeInventoryCondition(body.condition)
    const description = typeof body.description === 'string' ? body.description.trim().slice(0, 500) : ''
    const imageUrl = typeof body.imageUrl === 'string' ? body.imageUrl.trim().slice(0, 500) : ''
    // Permission check before any write. The UI hides the Add Item button for
    // staff without this permission, but that only stops the button — not a
    // request sent directly to this endpoint.
    const denied = await guardRequest(req, 'canManageInventory')
    if (denied) return denied

    const processedBy = await getProcessedByInfo(req)
    const remarks = typeof body.remarks === 'string' ? body.remarks.trim().slice(0, INPUT_LIMITS.note) : ''
    // Absent means unit tracking - the default for second-hand stock.
    const trackingMode = body.trackingMode === undefined ? 'unit' : normalizeTrackingMode(body.trackingMode)
    const unitPriceInput = toNumber(body.unitPrice, Number.NaN)
    const unitDetails: UnitDetails = {
      grade: normalizeUnitGrade(body.unitGrade),
      conditionNotes: cleanConditionNotes(body.unitNotes),
      priceOverride: Number.isFinite(unitPriceInput) && unitPriceInput > 0 ? unitPriceInput : null,
    }

    // Step 2: Validate required fields
    if (!name) {
      return NextResponse.json({ error: 'Item name is required.' }, { status: 400 })
    }

    if (![price, quantity, minStock].every((value) => Number.isFinite(value))) {
      return NextResponse.json({ error: 'Price, quantity, and minimum stock are required.' }, { status: 400 })
    }

    if (price <= 0 || quantity < 0 || minStock < 0) {
      return NextResponse.json({ error: 'Price must be greater than zero, and stock values cannot be negative.' }, { status: 400 })
    }

    if (quantity > MAX_STOCK || minStock > MAX_STOCK) {
      return NextResponse.json(
        { error: `Quantity and minimum stock cannot exceed ${MAX_STOCK}.` },
        { status: 400 }
      )
    }

    let categoryId = categoryIdInput
    let categoryName = categoryNameInput

    if (categoryId) {
      const categorySnapshot = await getAdminDb().collection('categories').doc(categoryId).get()
      if (!categorySnapshot.exists) {
        return NextResponse.json({ error: 'Category not found' }, { status: 404 })
      }

      const categoryData = (categorySnapshot.data() ?? {}) as Record<string, unknown>
      categoryName =
        typeof categoryData.name === 'string' && categoryData.name.trim() ? categoryData.name.trim() : categoryName
    } else if (categoryName) {
      const categorySnapshot = await getAdminDb()
        .collection('categories')
        .where('name', '==', categoryName)
        .get()
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

    // A single item never merges: two "Rice Cooker - Panasonic" units in
    // different states are two records. findInventoryVariant also ignores
    // single items, so adding ordinary stock never lands on one of them.
    const existingVariant = isSingleItem ? null : await findInventoryVariant({ name, categoryId, condition })

    if (existingVariant) {
      const now = new Date().toISOString()
      const updatedQuantity = existingVariant.stock + quantity
      const stockStatus = getStockStatus({ stock: updatedQuantity, minStock: existingVariant.minStock })
      const unitTracked = existingVariant.trackingMode === 'unit'
      const codes = unitTracked ? await allocateUnitCodes(quantity) : []
      let createdUnits: ReturnType<typeof writeNewUnits> = []

      await getAdminDb().runTransaction(async (txn) => {
      txn.update(existingVariant.ref, {
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
        ...(conditionNotes ? { conditionNotes } : {}),
        isDeleted: false,
        deletedAt: null,
        updatedAt: now,
      })
      if (unitTracked) {
        createdUnits = writeNewUnits(txn, {
          itemId: existingVariant.id,
          itemName: existingVariant.name,
          codes,
          details: unitDetails,
          nowIso: now,
          source: 'stock_increased',
        })
      }
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
        units: createdUnits.map((u) => ({ id: u.id, unitCode: u.unitCode, grade: u.grade })),
        remarks: (remarks || 'Inventory stock increased from add item flow.') + describeUnits(createdUnits),
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
            trackingMode: existingVariant.trackingMode,
          },
          // New pieces' codes, so their labels can be printed straight away.
          units: createdUnits.map((u) => ({ id: u.id, unitCode: u.unitCode, grade: u.grade })),
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
      isSingleItem,
      conditionNotes,
      trackingMode,
      unitDetails,
      source: 'item_added',
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
      units: created.units.map((u) => ({ id: u.id, unitCode: u.unitCode, grade: u.grade })),
      remarks: (remarks || 'New inventory variant created.') + describeUnits(created.units),
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
          trackingMode: created.trackingMode,
        },
        units: created.units.map((u) => ({ id: u.id, unitCode: u.unitCode, grade: u.grade })),
      },
      { status: 201 }
    )
  } catch (error) {
    console.error('POST /api/inventory error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
