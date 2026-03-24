const admin = require('firebase-admin')
const path = require('path')

const serviceAccount = require(path.resolve(__dirname, '../serviceAccountKey.json'))

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  })
}

const db = admin.firestore()
const Timestamp = admin.firestore.Timestamp

const END_DATE = new Date('2026-03-24T23:59:59')
const START_DATE = new Date('2025-01-01T00:00:00')

const categoriesSeed = [
  'Bags',
  'Clothing',
  'Footwear',
  'Accessories',
  'Kitchenware',
  'Appliances',
  'Electronics',
  'Furniture',
  'Toys',
  'Home Decor',
  'School Supplies',
  'Collectibles',
]

const baseInventorySeed = [
  ['Bags', 'Canvas Tote Bag - Tokyo Print', 280],
  ['Bags', 'Mini Backpack - Black', 650],
  ['Bags', 'Sling Bag - Beige', 320],
  ['Bags', 'School Backpack - Navy', 720],
  ['Bags', 'Travel Duffel Bag - Gray', 980],
  ['Bags', 'Hand Carry Bag - Cream', 430],
  ['Bags', 'Crossbody Bag - Brown', 350],

  ['Clothing', 'Cotton T-Shirt - White', 180],
  ['Clothing', 'Graphic T-Shirt - Anime Print', 220],
  ['Clothing', 'Polo Shirt - Blue', 260],
  ['Clothing', 'Zip Hoodie - Gray', 560],
  ['Clothing', 'Denim Jacket - Black', 950],
  ['Clothing', 'Long Sleeve Shirt - Beige', 240],
  ['Clothing', 'Pleated Skirt - Navy', 380],
  ['Clothing', 'Sweatshirt - Olive', 520],

  ['Footwear', 'Rubber Shoes - White', 1200],
  ['Footwear', 'Slip-On Shoes - Black', 680],
  ['Footwear', 'Flat Sandals - Brown', 250],
  ['Footwear', 'House Slippers - Blue', 120],
  ['Footwear', 'Running Shoes - Gray', 1100],
  ['Footwear', 'Canvas Shoes - Red', 540],

  ['Accessories', 'Anime Wallet - Black', 180],
  ['Accessories', 'Character Coin Purse - Pink', 90],
  ['Accessories', 'Mini Pouch - Sakura Print', 130],
  ['Accessories', 'Wrist Watch - Silver', 650],
  ['Accessories', 'Baseball Cap - Beige', 150],
  ['Accessories', 'Leather Belt - Brown', 170],
  ['Accessories', 'Card Holder - Gray', 110],
  ['Accessories', 'Sunglasses - Black', 220],

  ['Kitchenware', 'Ceramic Plate - Sakura Print', 80],
  ['Kitchenware', 'Japanese Bowl Set - White', 150],
  ['Kitchenware', 'Bento Lunch Box - Blue', 180],
  ['Kitchenware', 'Chopsticks Set - Wooden', 60],
  ['Kitchenware', 'Tea Cup Set - Floral', 140],
  ['Kitchenware', 'Rice Bowl - Cat Design', 120],
  ['Kitchenware', 'Serving Tray - Bamboo', 180],
  ['Kitchenware', 'Soup Spoon Set - White', 55],
  ['Kitchenware', 'Glass Cup - Clear', 70],
  ['Kitchenware', 'Nonstick Frying Pan - Black', 360],

  ['Appliances', 'Rice Cooker - White', 1850],
  ['Appliances', 'Electric Kettle - Silver', 650],
  ['Appliances', 'Mini Fan - Blue', 420],
  ['Appliances', 'Toaster Oven - Black', 1380],
  ['Appliances', 'Blender - White', 950],
  ['Appliances', 'Hair Dryer - Pink', 520],

  ['Electronics', 'Bluetooth Speaker - Black', 850],
  ['Electronics', 'Headphones - White', 720],
  ['Electronics', 'Wireless Mouse - Gray', 280],
  ['Electronics', 'Desk Lamp - White', 320],
  ['Electronics', 'Power Bank - Black', 550],
  ['Electronics', 'Phone Charger - White', 180],

  ['Furniture', 'Storage Cabinet - White', 2800],
  ['Furniture', 'Wooden Shelf - Brown', 1500],
  ['Furniture', 'Folding Table - Black', 1450],
  ['Furniture', 'Plastic Drawer - Clear', 780],
  ['Furniture', 'Office Chair - Gray', 2200],

  ['Toys', 'Plush Toy - Pikachu', 320],
  ['Toys', 'Character Doll - Sailor Moon', 420],
  ['Toys', 'Toy Car Set - Red', 180],
  ['Toys', 'Building Blocks Set - Multi', 320],
  ['Toys', 'Stuffed Plush - Totoro', 380],
  ['Toys', 'Puzzle Toy - Pokémon', 190],
  ['Toys', 'Mini Figure - Dragon Ball', 420],
  ['Toys', 'Gashapon Capsule Toy - Assorted', 95],

  ['Home Decor', 'Wall Clock - White', 420],
  ['Home Decor', 'Table Lamp - Warm White', 380],
  ['Home Decor', 'Storage Basket - Woven', 180],
  ['Home Decor', 'Decorative Vase - Blue', 220],
  ['Home Decor', 'Curtain Set - Floral', 480],
  ['Home Decor', 'Floor Mat - Gray', 250],

  ['School Supplies', 'Pencil Case - Anime Print', 95],
  ['School Supplies', 'Notebook Set - Sakura Theme', 120],
  ['School Supplies', 'Ballpen Set - Blue Ink', 60],
  ['School Supplies', 'Desk Organizer - White', 180],
  ['School Supplies', 'File Holder - Clear', 85],

  ['Collectibles', 'Anime Figure - Naruto', 850],
  ['Collectibles', 'Anime Figure - One Piece', 880],
  ['Collectibles', 'Character Standee - Demon Slayer', 280],
  ['Collectibles', 'Mini Figure - Attack on Titan', 430],
  ['Collectibles', 'Collector Tin Badge Set - Assorted', 150],
]

const firstNames = [
  'Aiko', 'Ren', 'Hana', 'Mika', 'Sora', 'Yuki', 'Kaito', 'Emi', 'Noah', 'Liam',
  'Ethan', 'Sophia', 'Mia', 'Lucas', 'Ava', 'Isla', 'Hiro', 'Ken', 'Aya', 'Rina',
]
const lastNames = [
  'Santos', 'Reyes', 'Cruz', 'Garcia', 'Mendoza', 'Tan', 'Dela Cruz', 'Yamamoto',
  'Sato', 'Tanaka', 'Lopez', 'Torres', 'Flores', 'Morales', 'Castro',
]

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function randomPick(arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}

function chance(p) {
  return Math.random() < p
}

function randomDateBetween(start, end) {
  return new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime()))
}

function formatDateKey(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}${m}${d}`
}

function formatReadableDate(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function makeCustomerName() {
  return `${randomPick(firstNames)} ${randomPick(lastNames)}`
}

function makePhoneNumber() {
  return `09${randomInt(10, 99)}${randomInt(100, 999)}${randomInt(1000, 9999)}`
}

function makeSaleId(counter) {
  return `SALE-${String(counter).padStart(5, '0')}`
}

function makeReservationId(counter) {
  return `RES-${String(counter).padStart(5, '0')}`
}

function stockStatus(stock, minStock) {
  if (stock <= 0) return 'out_of_stock'
  if (stock <= minStock) return 'low_stock'
  return 'in_stock'
}

async function clearCollection(collectionName) {
  const snapshot = await db.collection(collectionName).get()
  if (snapshot.empty) return

  let batch = db.batch()
  let count = 0

  for (const doc of snapshot.docs) {
    batch.delete(doc.ref)
    count++

    if (count % 400 === 0) {
      await batch.commit()
      batch = db.batch()
    }
  }

  if (count % 400 !== 0) {
    await batch.commit()
  }
}

function buildInventorySeed() {
  const generated = []

  for (const [category, name, newPrice] of baseInventorySeed) {
    const refurbishedPrice = Math.max(50, Math.round(newPrice * 0.72))

    generated.push({
      category,
      name,
      condition: 'New',
      price: newPrice,
      stock: randomInt(4, 12),
      minStock: category === 'Kitchenware' || category === 'School Supplies' ? 3 : 1,
    })

    generated.push({
      category,
      name,
      condition: 'Refurbished',
      price: refurbishedPrice,
      stock: randomInt(2, 7),
      minStock: 1,
    })
  }

  return generated
}

async function seedCategories() {
  const categoryMap = {}

  for (const name of categoriesSeed) {
    const ref = db.collection('categories').doc()
    const now = Timestamp.now()

    await ref.set({
      name,
      slug: name.toLowerCase().replace(/\s+/g, '-'),
      isActive: true,
      createdAt: now,
      updatedAt: now,
    })

    categoryMap[name] = ref.id
  }

  return categoryMap
}

async function seedInventory(categoryMap) {
  const inventorySeed = buildInventorySeed()
  const inventoryDocs = []

  for (const item of inventorySeed) {
    const ref = db.collection('inventory').doc()
    const now = Timestamp.now()

    const data = {
      name: item.name,
      categoryId: categoryMap[item.category],
      categoryName: item.category,
      condition: item.condition,
      price: item.price,
      stock: item.stock,
      minStock: item.minStock,
      stockStatus: stockStatus(item.stock, item.minStock),
      sku: `SKU-${ref.id.slice(0, 8).toUpperCase()}`,
      supplier: 'Japan Surplus Supplier',
      source: 'Japan Surplus',
      isActive: true,
      createdAt: now,
      updatedAt: now,
    }

    await ref.set(data)
    inventoryDocs.push({ id: ref.id, ...data })
  }

  console.log('Inventory total:', inventoryDocs.length)
  console.log('New total:', inventoryDocs.filter(i => i.condition === 'New').length)
  console.log('Refurbished total:', inventoryDocs.filter(i => i.condition === 'Refurbished').length)

  return inventoryDocs
}

async function seedSales(inventoryDocs) {
  const saleCounterByDay = {}
  const salesTarget = 950

  const newItems = inventoryDocs.filter(i => i.condition === 'New')
  const refurbishedItems = inventoryDocs.filter(i => i.condition === 'Refurbished')

  for (let i = 1; i <= salesTarget; i++) {
    const saleDate = randomDateBetween(START_DATE, END_DATE)
    const dateKey = formatDateKey(saleDate)
    saleCounterByDay[dateKey] = (saleCounterByDay[dateKey] || 0) + 1

    const desiredCount = randomInt(1, 4)
    const saleItems = []
    const used = new Set()

    // force 1 refurbished item in every sale
    const forcedRef = randomPick(refurbishedItems)
    used.add(forcedRef.id)
    saleItems.push(forcedRef)

    while (saleItems.length < desiredCount) {
      const pool = chance(0.5) ? refurbishedItems : newItems
      const picked = randomPick(pool)
      if (used.has(picked.id)) continue
      used.add(picked.id)
      saleItems.push(picked)
    }

    let subtotal = 0
    const items = saleItems.map((picked) => {
      const quantity = randomInt(1, Math.min(3, Math.max(1, picked.stock)))
      const total = picked.price * quantity
      subtotal += total

      return {
        productId: picked.id,
        name: picked.name,
        categoryId: picked.categoryId,
        categoryName: picked.categoryName,
        condition: picked.condition,
        price: picked.price,
        quantity,
        total,
        status: 'Sold',
      }
    })

    const discount = chance(0.15) ? randomInt(10, Math.min(120, Math.floor(subtotal * 0.12))) : 0
    const totalAmount = Math.max(0, subtotal - discount)

    await db.collection('sales').doc().set({
      saleId: makeSaleId(i),
      saleNumber: makeSaleId(i),
      customerName: chance(0.8) ? makeCustomerName() : 'Walk-in Customer',
      cashierName: randomPick(['Admin', 'Staff 1', 'Staff 2']),
      items,
      itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
      subtotal,
      discount,
      total: totalAmount,
      paymentMethod: randomPick(['Cash', 'GCash']),
      status: 'Completed',
      createdAt: Timestamp.fromDate(saleDate),
      updatedAt: Timestamp.fromDate(saleDate),
      dateKey: formatReadableDate(saleDate),
    })
  }

  return saleCounterByDay
}

async function seedReservations(inventoryDocs) {
  const reservationCounterByDay = {}
  const reservationTarget = 180

  const newItems = inventoryDocs.filter(i => i.condition === 'New')
  const refurbishedItems = inventoryDocs.filter(i => i.condition === 'Refurbished')

  for (let i = 1; i <= reservationTarget; i++) {
    const reservationDate = randomDateBetween(START_DATE, END_DATE)
    const expiresAt = new Date(reservationDate.getTime() + randomInt(1, 5) * 24 * 60 * 60 * 1000)
    const dateKey = formatDateKey(reservationDate)
    reservationCounterByDay[dateKey] = (reservationCounterByDay[dateKey] || 0) + 1

    const item = chance(0.5) ? randomPick(refurbishedItems) : randomPick(newItems)
    const quantity = randomInt(1, Math.min(2, Math.max(1, item.stock)))
    const total = item.price * quantity

    let status = 'Active'
    if (expiresAt < END_DATE && chance(0.55)) status = 'Completed'
    if (expiresAt < END_DATE && chance(0.18)) status = 'Cancelled'

    const reservationId = makeReservationId(i)

    await db.collection('reservations').doc().set({
      reservationId,
      reservationNumber: reservationId,
      customerName: makeCustomerName(),
      contactNumber: makePhoneNumber(),
      itemId: item.id,
      itemName: item.name,
      categoryId: item.categoryId,
      categoryName: item.categoryName,
      condition: item.condition,
      quantity,
      price: item.price,
      total,
      status,
      notes: chance(0.2) ? 'Customer requested hold for pickup.' : '',
      createdAt: Timestamp.fromDate(reservationDate),
      updatedAt: Timestamp.fromDate(reservationDate),
      reservedAt: Timestamp.fromDate(reservationDate),
      expiresAt: Timestamp.fromDate(expiresAt),
    })
  }

  return reservationCounterByDay
}

async function seedTransactionCounters(saleCounterByDay, reservationCounterByDay) {
  const allDates = new Set([
    ...Object.keys(saleCounterByDay),
    ...Object.keys(reservationCounterByDay),
  ])

  for (const dateKey of allDates) {
    await db.collection('transactionCounters').doc(`sale_${dateKey}`).set({
      type: 'sale',
      dateKey,
      count: saleCounterByDay[dateKey] || 0,
      updatedAt: Timestamp.now(),
    })

    await db.collection('transactionCounters').doc(`reservation_${dateKey}`).set({
      type: 'reservation',
      dateKey,
      count: reservationCounterByDay[dateKey] || 0,
      updatedAt: Timestamp.now(),
    })
  }
}

async function main() {
  try {
    await clearCollection('sales')
    await clearCollection('reservations')
    await clearCollection('inventory')
    await clearCollection('categories')
    await clearCollection('transactionCounters')

    const categoryMap = await seedCategories()
    const inventoryDocs = await seedInventory(categoryMap)
    const saleCounterByDay = await seedSales(inventoryDocs)
    const reservationCounterByDay = await seedReservations(inventoryDocs)
    await seedTransactionCounters(saleCounterByDay, reservationCounterByDay)

    console.log('Seeding complete.')
  } catch (error) {
    console.error('Seeder failed:', error)
    process.exit(1)
  }
}

main()