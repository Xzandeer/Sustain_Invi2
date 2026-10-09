/**
 * Two months of demonstration data for SUSTAIN.
 *
 * Derived from seed-year.js. Differences:
 *   - 61 days of trading instead of 365, ending today
 *   - only five categories: Accessories, Appliances, Kitchenware,
 *     School Supplies and Collectibles
 *   - two shipments (one at the start, one a month later) instead of twelve
 *   - a seedable random generator, so a run can be reproduced:
 *       node scripts/seed-two-months.js --force --seed=42
 *     (the default seed is 42; dates are relative to today, so the same seed
 *     gives the same pattern shifted to the current date)
 *
 * WHAT THIS PRODUCES
 *   - 2 shipments, each with a supplier and a purchase cost
 *   - every inventory item linked to the shipment it arrived in
 *   - a six-digit barcode on every item, and the counter left in the right place
 *   - two months of sales with a weekday rhythm and paydays
 *   - refunds, write-offs and stock adjustments spread through the period
 *   - a stock log entry for EVERY action above, in chronological order
 *
 * The seeder replays history day by day. Each event moves the running stock
 * and writes the matching log line, so the audit trail agrees with the stock
 * figures.
 *
 * RUN
 *   node scripts/seed-two-months.js --force
 *
 * Credentials come from .env.local, so it writes to whichever project that file
 * points at. It prints the project name before doing anything - read it. It
 * refuses to run without --force, because it DELETES the collections it owns.
 *
 * This data is synthetic. Label any results produced from it as such.
 */

const { initializeApp, cert, getApps } = require('firebase-admin/app')
const { getFirestore, Timestamp } = require('firebase-admin/firestore')
const fs = require('fs')
const path = require('path')

// ── Seedable random generator ────────────────────────────────────────────────

function parseSeed() {
  const arg = process.argv.find((value) => value.startsWith('--seed='))
  const parsed = arg ? Number(arg.split('=')[1]) : 42
  return Number.isFinite(parsed) ? parsed : 42
}

// mulberry32: small, fast, and good enough for demonstration data.
function createRng(seed) {
  let state = seed >>> 0
  return function random() {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const SEED = parseSeed()
const random = createRng(SEED)

// ── Credentials ──────────────────────────────────────────────────────────────

function loadCredentials() {
  const keyPath = path.resolve(__dirname, '../serviceAccountKey.json')
  if (fs.existsSync(keyPath)) {
    const account = require(keyPath)
    return { credential: cert(account), projectId: account.project_id }
  }

  const envPath = path.resolve(__dirname, '../.env.local')
  if (!fs.existsSync(envPath)) {
    throw new Error('No .env.local found, and no serviceAccountKey.json either.')
  }

  require('dotenv').config({ path: envPath })

  const projectId = process.env.FIREBASE_ADMIN_PROJECT_ID
  const clientEmail = process.env.FIREBASE_ADMIN_CLIENT_EMAIL
  // Stored with escaped newlines so it fits on one line of an env file.
  const privateKey = (process.env.FIREBASE_ADMIN_PRIVATE_KEY || '').replace(/\\n/g, '\n')

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      'FIREBASE_ADMIN_PROJECT_ID, FIREBASE_ADMIN_CLIENT_EMAIL and ' +
        'FIREBASE_ADMIN_PRIVATE_KEY must all be set in .env.local.'
    )
  }

  return {
    credential: cert({ projectId, clientEmail, privateKey }),
    projectId,
  }
}

const { credential, projectId: TARGET_PROJECT } = loadCredentials()

if (getApps().length === 0) {
  initializeApp({ credential })
}

const db = getFirestore()

// ── Configuration ────────────────────────────────────────────────────────────

const TRADING_DAYS = 61 // two months

// Ends today so the last seven days always contain sales. Analytics reads a
// trailing window for its category forecast, and a dataset that stops weeks ago
// makes a working forecast look broken.
const END_DATE = endOfDay(new Date())
const START_DATE = startOfDay(addDays(END_DATE, -(TRADING_DAYS - 1)))

const STORE_STAFF = [
  { uid: 'seed-staff-1', name: 'Maria Santos', email: 'maria@jmgs.local' },
  { uid: 'seed-staff-2', name: 'Ramon Cruz', email: 'ramon@jmgs.local' },
  { uid: 'seed-admin-1', name: 'Store Administrator', email: 'admin@jmgs.local' },
]

const SUPPLIERS = ['Kobe Surplus Trading', 'Osaka Bale Supply']

const CATEGORIES = ['Accessories', 'Appliances', 'Kitchenware', 'School Supplies', 'Collectibles']

const CATEGORY_CODES = {
  'Accessories': 'ACC',
  'Appliances': 'APP',
  'Kitchenware': 'KIT',
  'School Supplies': 'SCH',
  'Collectibles': 'COL',
}

// How often a category sells, relative to the others. Appliances and
// collectibles sell rarely, which gives the forecast some genuinely
// intermittent series to work on.
const CATEGORY_WEIGHT = {
  'Accessories': 12,
  'Kitchenware': 10,
  'School Supplies': 6,
  'Appliances': 4,
  'Collectibles': 3,
}
const MAX_WEIGHT = Math.max(...Object.values(CATEGORY_WEIGHT))

const PRODUCTS = [
  ['Accessories', 'Anime Wallet - Black', 180],
  ['Accessories', 'Character Coin Purse - Pink', 90],
  ['Accessories', 'Wrist Watch - Silver', 650],
  ['Accessories', 'Baseball Cap - Beige', 150],
  ['Accessories', 'Leather Belt - Brown', 170],
  ['Accessories', 'Sunglasses - Black', 220],
  ['Kitchenware', 'Ceramic Plate - Sakura Print', 80],
  ['Kitchenware', 'Japanese Bowl Set - White', 150],
  ['Kitchenware', 'Bento Lunch Box - Blue', 180],
  ['Kitchenware', 'Tea Cup Set - Floral', 140],
  ['Kitchenware', 'Rice Bowl - Cat Design', 120],
  ['Kitchenware', 'Nonstick Frying Pan - Black', 360],
  ['Appliances', 'Rice Cooker - White', 1850],
  ['Appliances', 'Electric Kettle - Silver', 650],
  ['Appliances', 'Mini Fan - Blue', 420],
  ['Appliances', 'Flat Iron - Pink', 480],
  ['School Supplies', 'Notebook Set - Ruled', 90],
  ['School Supplies', 'Pencil Case - Blue', 130],
  ['School Supplies', 'Art Set - 24 Colors', 320],
  ['School Supplies', 'Document Folder - Clear', 70],
  ['Collectibles', 'Anime Figure - Limited', 1450],
  ['Collectibles', 'Vintage Postcard Set', 220],
  ['Collectibles', 'Model Kit - Robot', 980],
]

const REFUND_REASONS = [
  ['defective', 'Item found defective after purchase'],
  ['wrong_item', 'Wrong item released to customer'],
  ['customer_changed_mind', 'Customer cancelled the purchase'],
  ['defective', 'Damage discovered on inspection'],
]

const VOID_REASONS = [
  'Damaged beyond resale during handling',
  'Water damage found in storage',
  'Missing parts, cannot be sold',
  'Heavy staining, unsellable',
]

// ── Small helpers ────────────────────────────────────────────────────────────

function startOfDay(date) {
  const copy = new Date(date)
  copy.setHours(0, 0, 0, 0)
  return copy
}

function endOfDay(date) {
  const copy = new Date(date)
  copy.setHours(23, 59, 59, 999)
  return copy
}

function addDays(date, days) {
  const copy = new Date(date)
  copy.setDate(copy.getDate() + days)
  return copy
}

function randomInt(min, max) {
  return Math.floor(random() * (max - min + 1)) + min
}

function pick(list) {
  return list[Math.floor(random() * list.length)]
}

function formatDateKey(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}${month}${day}`
}

function isoDate(date) {
  return date.toISOString().slice(0, 10)
}

function stockStatus(stock, minStock) {
  if (stock <= 0) return 'Out of Stock'
  if (stock <= minStock) return 'Low Stock'
  return 'In Stock'
}

function valueSummary(stock, reserved, condition) {
  return `Stock: ${stock}, Reserved: ${reserved}, Condition: ${condition}`
}

// ── How busy a given day is ──────────────────────────────────────────────────

/**
 * Returns how many sales happen on a date: busier weekends, paydays on the
 * 15th and 30th, and the usual seasonal lifts. The seasonal branches only
 * matter if the two-month window happens to cover those months.
 */
function salesForDate(date) {
  const day = date.getDay()
  const dayOfMonth = date.getDate()
  const month = date.getMonth()

  let base = 3
  if (day === 0) base = 6 // Sunday
  else if (day === 6) base = 7 // Saturday
  else if (day === 5) base = 5 // Friday

  // Paydays, and the two days that follow them.
  if (dayOfMonth >= 15 && dayOfMonth <= 17) base += 3
  if (dayOfMonth >= 30 || dayOfMonth <= 2) base += 3

  if (month === 11) base += 4 // December
  if (month === 0 && dayOfMonth > 5) base -= 2 // the January lull
  if (month === 5 || month === 10) base += 1 // school opening, pre-Christmas

  return Math.max(0, base + randomInt(-2, 2))
}

// ── Wiping what this script owns ─────────────────────────────────────────────

const OWNED_COLLECTIONS = [
  'sales', 'stockLogs', 'inventory', 'containers', 'categories',
  'reservations', 'receipts', 'transactionCounters',
]

async function deleteCollection(name) {
  let removed = 0
  while (true) {
    const snapshot = await db.collection(name).limit(400).get()
    if (snapshot.empty) break
    const batch = db.batch()
    snapshot.docs.forEach((docSnap) => batch.delete(docSnap.ref))
    await batch.commit()
    removed += snapshot.size
  }
  return removed
}

// ── Writer that keeps batches under Firestore's limit ────────────────────────

class BatchWriter {
  constructor() {
    this.batch = db.batch()
    this.pending = 0
    this.total = 0
  }

  // options must be forwarded, or { merge: true } is silently dropped and the
  // write replaces the whole document.
  set(ref, data, options) {
    if (options) {
      this.batch.set(ref, data, options)
    } else {
      this.batch.set(ref, data)
    }
    this.pending += 1
    this.total += 1
    return this.pending >= 400 ? this.flush() : Promise.resolve()
  }

  async flush() {
    if (this.pending === 0) return
    await this.batch.commit()
    this.batch = db.batch()
    this.pending = 0
  }
}

// ── Seeding ──────────────────────────────────────────────────────────────────

async function seedCategories(writer) {
  const map = {}
  for (const name of CATEGORIES) {
    const ref = db.collection('categories').doc()
    const now = Timestamp.fromDate(START_DATE)
    await writer.set(ref, {
      name,
      slug: name.toLowerCase().replace(/\s+/g, '-'),
      isActive: true,
      createdAt: now,
      updatedAt: now,
    })
    map[name] = ref.id
  }
  return map
}

/**
 * Two shipments: one at the very start, one a little over a month later.
 *
 * The second offset is 31-33 days, which always lands in a different calendar
 * month from the first, so the shipment names never collide.
 *
 * Purchase cost is filled in from what each shipment actually contains.
 */
function buildShipments() {
  const offsets = [randomInt(0, 1), 31 + randomInt(0, 2)]
  const shipments = []

  offsets.forEach((offset, index) => {
    const arrival = addDays(START_DATE, offset)
    if (arrival > END_DATE) return

    const label = arrival.toLocaleString('en-US', { month: 'short' }).toUpperCase()
    shipments.push({
      ref: db.collection('containers').doc(),
      name: `${label} ${arrival.getFullYear()} Shipment`,
      supplier: SUPPLIERS[index % SUPPLIERS.length],
      arrival,
      purchaseCost: 0,
      items: [],
    })
  })

  return shipments
}

/**
 * Creates the inventory, distributing every product across the shipments.
 * Each product exists twice - New and Refurbished - as separate documents.
 */
function buildInventory(shipments, categoryMap) {
  const items = []
  const skuCounters = {}
  let barcodeSequence = 0

  PRODUCTS.forEach((entry, productIndex) => {
    const [category, name, newPrice] = entry

    for (const condition of ['New', 'Refurbished']) {
      // New and Refurbished versions of a product arrive in different
      // shipments, so each shipment holds a mixture.
      const shipment = shipments[(productIndex + (condition === 'New' ? 0 : 1)) % shipments.length]

      const price = condition === 'New' ? newPrice : Math.max(50, Math.round(newPrice * 0.72))
      const received = condition === 'New' ? randomInt(6, 20) : randomInt(4, 12)

      const code = CATEGORY_CODES[category]
      const conditionCode = condition === 'New' ? 'N' : 'R'
      const key = `${code}-${conditionCode}`
      skuCounters[key] = (skuCounters[key] || 0) + 1

      barcodeSequence += 1

      // Cost is roughly 45% of the selling price, so shipment ROI is
      // internally consistent.
      const unitCost = Math.round(price * 0.45)
      shipment.purchaseCost += unitCost * received

      const item = {
        ref: db.collection('inventory').doc(),
        name,
        category,
        categoryId: categoryMap[category],
        condition,
        price,
        unitCost,
        received,
        stock: received,
        reserved: 0,
        minStock: category === 'Kitchenware' || category === 'School Supplies' ? 3 : 2,
        sku: `${code}-${conditionCode}-${String(skuCounters[key]).padStart(3, '0')}`,
        barcode: String(barcodeSequence).padStart(6, '0'),
        shipment,
        voidedUnits: 0,
        isVoided: false,
        // Roughly one line in twenty is not reordered once it sells out, which
        // gives the Dashboard something to report as out of stock.
        discontinued: random() < 0.05,
      }

      shipment.items.push(item)
      items.push(item)
    }
  })

  return { items, barcodeSequence }
}

/**
 * Written after the period has been replayed, because purchase cost grows when
 * stock is replenished and status depends on how much is left.
 */
async function writeShipments(writer, shipments) {
  for (const shipment of shipments) {
    const remaining = shipment.items.reduce((sum, item) => sum + item.stock, 0)
    const receivedTotal = shipment.items.reduce((sum, item) => sum + item.received, 0)
    const soldShare = receivedTotal > 0 ? 1 - remaining / receivedTotal : 0

    const status = remaining === 0 ? 'Sold Out' : soldShare >= 0.35 ? 'Partially Sold' : 'Active'

    await writer.set(shipment.ref, {
      name: shipment.name,
      supplier: shipment.supplier,
      purchaseCost: shipment.purchaseCost,
      purchaseDate: isoDate(shipment.arrival),
      notes: `${shipment.items.length} item lines received from ${shipment.supplier}.`,
      status,
      createdAt: Timestamp.fromDate(shipment.arrival),
    })
  }
}

async function writeInventory(writer, items, logs) {
  for (const item of items) {
    // Eight in the morning, before the shop opens at nine, so the "Item added"
    // line sits above the first sale of that day.
    const arrival = new Date(item.shipment.arrival)
    arrival.setHours(8, randomInt(0, 45), randomInt(0, 59), 0)

    await writer.set(item.ref, {
      name: item.name,
      categoryId: item.categoryId,
      categoryName: item.category,
      condition: item.condition,
      price: item.price,
      stock: item.received,
      quantity: item.received,
      minStock: item.minStock,
      reservedStock: 0,
      stockStatus: stockStatus(item.received, item.minStock),
      sku: item.sku,
      barcode: item.barcode,
      containerId: item.shipment.ref.id,
      supplier: item.shipment.supplier,
      source: 'Japan Surplus',
      isActive: true,
      isDeleted: false,
      isVoided: false,
      createdAt: Timestamp.fromDate(arrival),
      updatedAt: Timestamp.fromDate(arrival),
    })

    // Receiving stock is itself an action; the audit trail opens with it.
    logs.push({
      at: arrival,
      actionType: 'item_added',
      itemId: item.ref.id,
      itemName: item.name,
      condition: item.condition,
      quantityBefore: 0,
      quantityChanged: item.received,
      quantityAfter: item.received,
      user: STORE_STAFF[2],
      remarks: `Received in ${item.shipment.name} from ${item.shipment.supplier}.`,
      relatedId: item.shipment.ref.id,
    })
  }
}

/** Picks an item to sell, favouring categories that actually move. */
function pickSellableItem(available) {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const item = pick(available)
    if (!item || item.stock <= 0 || item.isVoided) continue
    const weight = CATEGORY_WEIGHT[item.category] ?? 5
    if (random() * MAX_WEIGHT <= weight) return item
  }
  return available.find((item) => item.stock > 0 && !item.isVoided) ?? null
}

/**
 * Walks the period day by day, creating sales and the stock movements they
 * cause. Stock is carried forward in memory, so an item cannot sell more than
 * it has, and the closing stock written to Firestore is the result of the
 * history rather than a number chosen separately from it.
 */
async function seedSalesAndEvents(writer, items, logs) {
  const salesByDay = {}
  const sales = []
  let voidCount = 0
  let adjustCount = 0

  // Items join the sellable pool as their shipment lands, so an item never has
  // a "Sold" line above its own "Item added" line.
  const pending = [...items].sort(
    (a, b) => a.shipment.arrival.getTime() - b.shipment.arrival.getTime()
  )
  const available = []

  // Refunds are scheduled when the sale is made and settled on the day they
  // fall due, inside this same loop, so every stock movement stays in
  // chronological order.
  const refundQueue = new Map()
  const refundsApplied = []

  for (let cursor = new Date(START_DATE); cursor <= END_DATE; cursor = addDays(cursor, 1)) {
    const dateKey = formatDateKey(cursor)
    const dayEnd = endOfDay(cursor)

    // Decided once per day and reused, so the time slots below are sized for
    // the number of sales that actually happen.
    const count = salesForDate(cursor)

    // A clock that only moves forward, shared by everything that happens today.
    const clock = new Date(cursor)
    clock.setHours(9, randomInt(0, 20), randomInt(0, 59), 0)

    // Closing time - or a minute ago, if today is still in progress.
    const closing = new Date(cursor)
    closing.setHours(20, 30, 0, 0)
    const rightNow = new Date()
    const windowEnd = closing > rightNow ? new Date(rightNow.getTime() - 60_000) : closing

    // Sized so the whole day fits: its sales plus room for refunds, restocks
    // and write-offs.
    const slots = Math.max(1, count + 10)
    const step = Math.max(1000, Math.floor((windowEnd.getTime() - clock.getTime()) / slots))

    let lastMoment = null

    const nextMoment = () => {
      clock.setTime(clock.getTime() + step)
      let value = clock > windowEnd ? new Date(windowEnd) : new Date(clock)

      // Strictly increasing, so the sorted audit trail never places a later
      // event before an earlier one.
      if (lastMoment && value <= lastMoment) value = new Date(lastMoment.getTime() + 1000)

      lastMoment = value
      return value
    }

    while (pending.length > 0 && pending[0].shipment.arrival <= dayEnd) {
      available.push(pending.shift())
    }
    if (available.length === 0) continue

    // Settle refunds due today, before the day's trading.
    for (const refund of refundQueue.get(dateKey) ?? []) {
      const before = refund.line.item.stock
      refund.line.item.stock += refund.quantity
      refund.at = nextMoment()
      refundsApplied.push(refund)

      logs.push({
        at: refund.at,
        actionType: 'sale_refund',
        itemId: refund.line.item.ref.id,
        itemName: refund.line.item.name,
        condition: refund.line.item.condition,
        quantityBefore: before,
        quantityChanged: refund.quantity,
        quantityAfter: refund.line.item.stock,
        user: pick(STORE_STAFF),
        remarks: `Refund for ${refund.sale.invoiceNumber}. ${refund.reasonText}`,
        relatedId: refund.sale.ref.id,
      })
    }
    refundQueue.delete(dateKey)

    for (let index = 0; index < count; index += 1) {
      const when = nextMoment()
      const lineCount = randomInt(1, 3)
      const lines = []
      const chosen = new Set()

      for (let line = 0; line < lineCount; line += 1) {
        const item = pickSellableItem(available)
        if (!item || chosen.has(item.ref.id)) continue

        const quantity = Math.min(item.stock, randomInt(1, item.price > 900 ? 1 : 3))
        if (quantity <= 0) continue

        chosen.add(item.ref.id)
        const stockBefore = item.stock
        item.stock -= quantity

        lines.push({
          item,
          quantity,
          stockBefore,
          stockAfter: item.stock,
        })
      }

      if (lines.length === 0) continue

      salesByDay[dateKey] = (salesByDay[dateKey] || 0) + 1
      const sequence = salesByDay[dateKey]
      const invoiceNumber = `INV-${dateKey}-${String(sequence).padStart(4, '0')}`

      const saleRef = db.collection('sales').doc()
      const totalAmount = lines.reduce((sum, line) => sum + line.quantity * line.item.price, 0)
      const categoryNames = Array.from(new Set(lines.map((line) => line.item.category)))
      const staff = pick(STORE_STAFF)

      const saleRecord = {
        ref: saleRef,
        when,
        totalAmount,
        lines,
        staff,
        invoiceNumber,
        refunded: false,
      }
      sales.push(saleRecord)

      await writer.set(saleRef, {
        id: saleRef.id,
        receiptNumber: invoiceNumber,
        searchableNumber: invoiceNumber,
        transactionType: 'sale',
        dateKey,
        sequenceNumber: sequence,
        customerSearchEmail: '',
        items: lines.map((line) => ({
          itemId: line.item.ref.id,
          name: line.item.name,
          quantity: line.quantity,
          price: line.item.price,
          categoryId: line.item.categoryId,
          categoryName: line.item.category,
          condition: line.item.condition,
          warrantyDays: 7,
          status: 'completed',
          refundedQuantity: 0,
        })),
        categoryName: categoryNames.join(', '),
        category: categoryNames.join(', '),
        // Walk-in sales collect no customer details - see the privacy change.
        customer: '',
        customerName: '',
        customerEmail: '',
        customerContactNumber: '',
        totalAmount,
        quantity: lines.reduce((sum, line) => sum + line.quantity, 0),
        total: totalAmount,
        amount: totalAmount,
        status: 'Completed',
        warrantyDays: 7,
        processedByName: staff.name,
        processedByEmail: staff.email,
        createdAt: Timestamp.fromDate(when),
        transactionDate: when.toISOString(),
      })

      for (const line of lines) {
        logs.push({
          at: when,
          actionType: 'sale_deduction',
          itemId: line.item.ref.id,
          itemName: line.item.name,
          condition: line.item.condition,
          quantityBefore: line.stockBefore,
          quantityChanged: -line.quantity,
          quantityAfter: line.stockAfter,
          user: staff,
          remarks: `Sale ${invoiceNumber} completed.`,
          relatedId: saleRef.id,
        })
      }

      // Decide now whether this sale comes back, and when - within the shop's
      // seven-day warranty window.
      if (random() < 0.035) {
        const line = pick(lines)
        const dueDate = addDays(when, randomInt(1, 6))
        if (dueDate <= END_DATE) {
          const [reasonCategory, reasonText] = pick(REFUND_REASONS)
          const key = formatDateKey(dueDate)
          const queued = refundQueue.get(key) ?? []
          queued.push({
            sale: saleRecord,
            line,
            quantity: randomInt(1, line.quantity),
            reasonCategory,
            reasonText,
          })
          refundQueue.set(key, queued)
        }
      }
    }

    // Replenishment. Every low item is considered every day and topped back up
    // to a working level; the probability spreads reorders across days.
    for (const item of available) {
      if (item.isVoided || item.stock > item.minStock) continue
      // A few lines are never reordered, so they sell out and stay out.
      if (item.discontinued) continue
      if (random() > 0.3) continue

      const target = randomInt(12, 28)
      const added = Math.max(4, target - item.stock)
      const before = item.stock
      item.stock += added
      adjustCount += 1

      // Restocked units were bought, so they belong in the shipment's cost.
      item.shipment.purchaseCost += item.unitCost * added
      item.received += added

      logs.push({
        at: nextMoment(),
        actionType: 'stock_increased',
        itemId: item.ref.id,
        itemName: item.name,
        condition: item.condition,
        quantityBefore: before,
        quantityChanged: added,
        quantityAfter: item.stock,
        user: STORE_STAFF[2],
        remarks: 'Restocked from reserve inventory.',
        relatedId: '',
      })
    }

    // Occasional write-off: second-hand goods get damaged in storage.
    if (random() < 0.06) {
      const candidates = available.filter((item) => !item.isVoided && item.stock >= 2)
      if (candidates.length > 0) {
        const item = pick(candidates)
        const units = randomInt(1, Math.min(2, item.stock))
        const before = item.stock
        item.stock -= units
        item.voidedUnits += units
        voidCount += 1

        logs.push({
          at: nextMoment(),
          actionType: 'item_voided',
          itemId: item.ref.id,
          itemName: item.name,
          condition: item.condition,
          quantityBefore: before,
          quantityChanged: -units,
          quantityAfter: item.stock,
          user: STORE_STAFF[2],
          remarks: `Partial void: ${units} of ${before} units removed. Reason: ${pick(VOID_REASONS)}`,
          relatedId: '',
        })
      }
    }
  }

  return { sales, refundsApplied, voidCount, adjustCount }
}

/**
 * Writes the refund result onto the sale documents. The stock movement and the
 * log line already happened, on the correct day, inside the main loop.
 */
async function writeRefunds(writer, refunds) {
  for (const refund of refunds) {
    const { sale, line } = refund
    const fullyRefunded = refund.quantity >= line.quantity && sale.lines.length === 1

    await writer.set(
      sale.ref,
      {
        items: sale.lines.map((current) => ({
          itemId: current.item.ref.id,
          name: current.item.name,
          quantity: current.quantity,
          price: current.item.price,
          categoryId: current.item.categoryId,
          categoryName: current.item.category,
          condition: current.item.condition,
          warrantyDays: 7,
          status: current === line && fullyRefunded ? 'refunded' : 'completed',
          refundedQuantity: current === line ? refund.quantity : 0,
        })),
        status: fullyRefunded ? 'refunded' : 'partially_refunded',
        refundedAt: Timestamp.fromDate(refund.at),
        refundReason: refund.reasonText,
        refundReasonCategory: refund.reasonCategory,
        refundedAmount: refund.quantity * line.item.price,
      },
      { merge: true }
    )
  }

  return refunds.length
}

/** Writes the closing stock, which is whatever the period's events left behind. */
async function writeFinalInventoryState(writer, items) {
  for (const item of items) {
    await writer.set(
      item.ref,
      {
        stock: item.stock,
        quantity: item.stock,
        stockStatus: stockStatus(item.stock, item.minStock),
        voidedUnits: item.voidedUnits,
        ...(item.voidedUnits > 0 ? { voidedQuantity: item.voidedUnits } : {}),
        updatedAt: Timestamp.fromDate(END_DATE),
      },
      { merge: true }
    )
  }
}

/** Writes the audit trail in the order the events actually happened. */
async function writeStockLogs(writer, logs) {
  logs.sort((a, b) => a.at.getTime() - b.at.getTime())

  for (const entry of logs) {
    await writer.set(db.collection('stockLogs').doc(), {
      createdAt: Timestamp.fromDate(entry.at),
      actionType: entry.actionType,
      itemId: entry.itemId,
      itemName: entry.itemName,
      condition: entry.condition,
      quantityBefore: entry.quantityBefore,
      quantityChanged: entry.quantityChanged,
      quantityAfter: entry.quantityAfter,
      stockBefore: entry.quantityBefore,
      stockAfter: entry.quantityAfter,
      reservedBefore: 0,
      reservedAfter: 0,
      previousValue: valueSummary(entry.quantityBefore, 0, entry.condition),
      newValue: valueSummary(entry.quantityAfter, 0, entry.condition),
      userName: entry.user.name,
      userEmail: entry.user.email,
      userId: entry.user.uid,
      remarks: entry.remarks,
      relatedId: entry.relatedId,
    })
  }
}

/**
 * Leaves the counters where the app expects to find them, so the first barcode
 * and invoice created after seeding do not collide with seeded ones.
 */
async function writeCounters(writer, barcodeSequence, sales) {
  await writer.set(db.collection('transactionCounters').doc('itemBarcode'), {
    sequence: barcodeSequence,
    updatedAt: Timestamp.fromDate(END_DATE),
  })

  const byDay = {}
  for (const sale of sales) {
    const key = formatDateKey(sale.when)
    byDay[key] = (byDay[key] || 0) + 1
  }

  for (const [dateKey, sequence] of Object.entries(byDay)) {
    await writer.set(db.collection('transactionCounters').doc(`sale_${dateKey}`), {
      dateKey,
      sequence,
      updatedAt: Timestamp.fromDate(END_DATE),
    })
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  if (!process.argv.includes('--force')) {
    console.error(`\nTARGET PROJECT: ${TARGET_PROJECT}`)
    console.error('\nThis deletes and rebuilds sales, inventory, shipments,')
    console.error('categories, stock logs and counters in that project.')
    console.error('Users, store settings and sign-in accounts are left alone.')
    console.error('\nCheck the project above is your DEMO project, then run:')
    console.error('  node scripts/seed-two-months.js --force [--seed=42]\n')
    process.exit(1)
  }

  console.log(`Project: ${TARGET_PROJECT}`)
  console.log(`Range:   ${isoDate(START_DATE)} to ${isoDate(END_DATE)} (${TRADING_DAYS} days)`)
  console.log(`Seed:    ${SEED}\n`)

  console.log('Clearing existing data...')
  for (const name of OWNED_COLLECTIONS) {
    const removed = await deleteCollection(name)
    console.log(`  ${name}: ${removed} removed`)
  }

  const writer = new BatchWriter()
  const logs = []

  console.log('\nCategories...')
  const categoryMap = await seedCategories(writer)

  console.log('Shipments and inventory...')
  const shipments = buildShipments()
  const { items, barcodeSequence } = buildInventory(shipments, categoryMap)
  await writeInventory(writer, items, logs)

  console.log('Replaying two months of trading...')
  const { sales, refundsApplied, voidCount, adjustCount } = await seedSalesAndEvents(writer, items, logs)

  console.log('Refunds...')
  const refundCount = await writeRefunds(writer, refundsApplied)

  console.log('Closing stock...')
  await writeFinalInventoryState(writer, items)
  await writeShipments(writer, shipments)

  console.log('Audit trail...')
  await writeStockLogs(writer, logs)

  console.log('Counters...')
  await writeCounters(writer, barcodeSequence, sales)

  await writer.flush()

  const revenue = sales.reduce((sum, sale) => sum + sale.totalAmount, 0)
  const purchaseTotal = shipments.reduce((sum, shipment) => sum + shipment.purchaseCost, 0)

  console.log('\nDone.')
  console.log(`  Shipments      ${shipments.length}`)
  console.log(`  Items          ${items.length}`)
  console.log(`  Sales          ${sales.length}`)
  console.log(`  Refunds        ${refundCount}`)
  console.log(`  Write-offs     ${voidCount}`)
  console.log(`  Restocks       ${adjustCount}`)
  console.log(`  Stock logs     ${logs.length}`)
  console.log(`  Documents      ${writer.total}`)
  console.log(`  Revenue        PHP ${revenue.toLocaleString('en-PH')}`)
  console.log(`  Purchase cost  PHP ${purchaseTotal.toLocaleString('en-PH')}`)
  console.log('\nCreate your admin account through the app - this script does')
  console.log('not touch the users collection or Firebase Auth.\n')
}

main().catch((error) => {
  console.error('\nSeeding failed:', error)
  process.exit(1)
})
