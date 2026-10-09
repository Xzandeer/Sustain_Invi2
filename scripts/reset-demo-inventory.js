// Replace the demo inventory with a realistic Japan-surplus catalogue.
//
//   node scripts/reset-demo-inventory.js
//       Dry run. Shows what would be deleted and created. Nothing is changed.
//
//   node scripts/reset-demo-inventory.js --confirm
//       Deletes and recreates.
//
// WHAT IT DELETES (permanently)
//   - inventory, categories, reservations and stockLogs - all of them
//   - sales recorded under an @jmgs.local account (seeded and simulated sales),
//     because they point at items that will no longer exist.
//   Sales rung up with real accounts, users, settings and the imported notebook
//   history (salesHistory) are kept.
//
// WHAT IT CREATES
//   - 5 categories: School Supplies, Accessories, Kitchenware, Collectibles,
//     Appliances - each item priced within its category's band
//   - regular stocked items (some deliberately low or out of stock, so the
//     dashboard alerts have something to show)
//   - SINGLE ITEMS: one-off pieces such as a refrigerator or a dining table,
//     each with its own condition notes
//   - a barcode and SKU on every item, and an "item added" stock-log line
//
// AFTERWARDS
//   node scripts/simulate-sales-from-history.js --confirm
//   to rebuild the simulated sales against the new items.
//
// Only runs against a project whose ID contains "demo", so it cannot wipe the
// store's real database by mistake. Download a backup first anyway.

const { db, projectId, FieldValue } = require('./lib/adminDb')

const confirm = process.argv.slice(2).includes('--confirm')

if (!/demo/i.test(projectId)) {
  console.error(`Refusing to run: project "${projectId}" is not a demo project.`)
  process.exit(1)
}

const SETUP_USER = { name: 'Demo setup', email: 'setup@jmgs.local', uid: '' }

const CATEGORY_CODES = {
  Bags: 'BAG', Clothing: 'CLO', Footwear: 'FTW', Accessories: 'ACC',
  Kitchenware: 'KIT', Appliances: 'APP', Electronics: 'ELC', Furniture: 'FUR',
  Toys: 'TOY', 'Home Decor': 'HMD', 'School Supplies': 'SCH', Collectibles: 'COL',
}

// Five categories, each with its own price band so prices make sense for
// what is being sold:
//   School Supplies    P60 - P650
//   Accessories        P80 - P3,500
//   Kitchenware        P90 - P2,800
//   Collectibles       P150 - P4,500
//   Appliances         P450 - P8,500

// [name, category, price, stock, minStock, condition]
const STOCKED = [
  // School Supplies
  ['Ballpen Set (10 pcs)', 'School Supplies', 60, 50, 15, 'New'],
  ['Geometry Set', 'School Supplies', 90, 20, 6, 'New'],
  ['Notebook A5 (5 pcs)', 'School Supplies', 120, 40, 10, 'New'],
  ['Stapler', 'School Supplies', 120, 12, 4, 'New'],
  ['Pencil Case', 'School Supplies', 150, 15, 5, 'New'],
  ['Scientific Calculator', 'School Supplies', 250, 8, 3, 'Refurbished'],
  ['Art Set - 24 Colors', 'School Supplies', 280, 10, 4, 'New'],
  ['Student Backpack', 'School Supplies', 650, 5, 2, 'Refurbished'],
  // Accessories
  ['Hair Clip Set', 'Accessories', 80, 30, 10, 'New'],
  ['Coin Purse', 'Accessories', 120, 25, 8, 'New'],
  ['Sunglasses', 'Accessories', 180, 15, 5, 'New'],
  ['Cotton Scarf', 'Accessories', 200, 0, 3, 'New'],
  ['Canvas Tote Bag', 'Accessories', 220, 20, 6, 'New'],
  ['Folding Umbrella', 'Accessories', 250, 20, 6, 'New'],
  ['Leather Belt', 'Accessories', 350, 10, 4, 'Refurbished'],
  ['Casual Wrist Watch', 'Accessories', 650, 3, 3, 'Refurbished'],
  // Kitchenware
  ['Wooden Chopsticks Set (10 pairs)', 'Kitchenware', 90, 60, 15, 'New'],
  ['Ceramic Rice Bowl Set (5 pcs)', 'Kitchenware', 180, 40, 10, 'New'],
  ['Glass Tumbler Set (6 pcs)', 'Kitchenware', 220, 18, 6, 'New'],
  ['Bento Box - 2 Tier', 'Kitchenware', 250, 25, 8, 'New'],
  ['Lacquer Serving Tray', 'Kitchenware', 280, 3, 4, 'New'],
  ['Porcelain Tea Cup Set - Floral', 'Kitchenware', 350, 10, 4, 'New'],
  ['Stainless Steel Pot 24cm', 'Kitchenware', 650, 12, 4, 'Refurbished'],
  ['Cast Iron Frying Pan 26cm', 'Kitchenware', 780, 6, 3, 'Refurbished'],
  // Collectibles
  ['Vintage Postcard Set', 'Collectibles', 150, 20, 5, 'New'],
  ['Furin Wind Chime', 'Collectibles', 180, 12, 4, 'New'],
  ['Mini Ceramic Figurine - Assorted', 'Collectibles', 220, 15, 5, 'New'],
  ['Daruma Doll - Small', 'Collectibles', 250, 10, 3, 'New'],
  ['Kokeshi Doll', 'Collectibles', 300, 3, 3, 'New'],
  ['Maneki-neko Lucky Cat', 'Collectibles', 380, 6, 2, 'New'],
  // Appliances
  ['Flat Iron', 'Appliances', 450, 2, 3, 'Refurbished'],
  ['Hand Mixer', 'Appliances', 520, 4, 2, 'Refurbished'],
  ['Hair Dryer', 'Appliances', 550, 7, 3, 'Refurbished'],
  ['Bread Toaster 2-Slice', 'Appliances', 680, 0, 2, 'Refurbished'],
  ['Electric Kettle 1.2L', 'Appliances', 750, 8, 3, 'Refurbished'],
  ['Desk Fan 12"', 'Appliances', 850, 5, 2, 'Refurbished'],
  ['Rice Cooker 1.0L', 'Appliances', 1200, 6, 3, 'Refurbished'],
  ['Microwave Oven 20L', 'Appliances', 2800, 3, 2, 'Refurbished'],
]

// [name, category, price, condition, conditionNotes] - one physical unit each.
// Priced at the top of their category's band: one-offs are the bigger,
// better pieces.
const SINGLES = [
  ['Panasonic 2-Door Refrigerator', 'Appliances', 8500, 'Refurbished',
    'Small dent on the right door. Cooling tested OK. Includes one shelf.'],
  ['Sharp Washing Machine 7kg', 'Appliances', 6800, 'Refurbished',
    'Top-load. Spin and drain tested. Lid hinge slightly loose.'],
  ['Toshiba Microwave with Grill', 'Appliances', 3500, 'Refurbished',
    'Turntable plate replaced. Faint scratches on the door.'],
  ['Zojirushi IH Rice Cooker', 'Appliances', 3200, 'Refurbished',
    'Inner pot coating intact. Minor scratches on the lid.'],
  ['Hitachi Air Purifier', 'Appliances', 2900, 'Refurbished',
    'Filter cleaned; replacement filter recommended within 6 months.'],
  ['Kutani Porcelain Vase - Large', 'Collectibles', 4500, 'New',
    'Unused, with original wooden box. Hand-painted.'],
  ['Hakata Doll in Glass Case', 'Collectibles', 3800, 'Refurbished',
    'Doll in good condition. Small chip on one corner of the glass case.'],
  ['Seiko Wooden Wall Clock', 'Collectibles', 2400, 'Refurbished',
    'Movement replaced (battery type). Light scratches on the case.'],
  ['Imari Plate Set (5 pcs)', 'Kitchenware', 2800, 'New',
    'Unused set. One plate has a tiny glaze bubble on the rim.'],
  ['Cast Iron Tetsubin Kettle', 'Kitchenware', 1900, 'Refurbished',
    'Light surface rust inside the spout, cleaned. Lid fits well.'],
  ['Seiko Automatic Wristwatch', 'Accessories', 3500, 'Refurbished',
    'Running well, keeps time. Strap replaced; light scratches on the case.'],
  ['Leather Briefcase', 'Accessories', 2200, 'Refurbished',
    'Genuine leather. Handle worn but strong. Inside lining clean.'],
]

const stockStatusOf = (stock, minStock) =>
  stock === 0 ? 'Out of Stock' : stock <= minStock ? 'Low Stock' : 'Available'

async function deleteCollection(name, filter) {
  let deleted = 0
  const snap = await db.collection(name).get()
  const docs = filter ? snap.docs.filter((d) => filter(d.data())) : snap.docs
  for (let i = 0; i < docs.length; i += 400) {
    const batch = db.batch()
    docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref))
    await batch.commit()
    deleted += Math.min(400, docs.length - i)
  }
  return deleted
}

async function countCollection(name, filter) {
  const snap = await db.collection(name).get()
  return filter ? snap.docs.filter((d) => filter(d.data())).length : snap.size
}

const isDemoSale = (d) => /@jmgs\.local$/i.test(String(d.processedByEmail || ''))

async function main() {
  console.log(`Project: ${projectId}\n`)

  const counts = {
    inventory: await countCollection('inventory'),
    categories: await countCollection('categories'),
    reservations: await countCollection('reservations'),
    stockLogs: await countCollection('stockLogs'),
    'sales (@jmgs.local)': await countCollection('sales', isDemoSale),
  }
  console.log('Will delete:')
  Object.entries(counts).forEach(([k, v]) => console.log(`  ${k.padEnd(22)} ${v}`))

  const categoryNames = Array.from(new Set([...STOCKED, ...SINGLES].map((r) => r[1])))
  console.log('\nWill create:')
  console.log(`  categories             ${categoryNames.length} (${categoryNames.join(', ')})`)
  console.log(`  stocked items          ${STOCKED.length}`)
  console.log(`  single items           ${SINGLES.length} (with condition notes)`)

  if (!confirm) {
    console.log('\nDry run - nothing changed. Add --confirm to reset.')
    return
  }

  // ── Delete ────────────────────────────────────────────────────────────────
  for (const name of ['inventory', 'categories', 'reservations', 'stockLogs']) {
    const n = await deleteCollection(name)
    console.log(`Deleted ${n} from ${name}`)
  }
  console.log(`Deleted ${await deleteCollection('sales', isDemoSale)} demo sales`)

  // ── Categories ────────────────────────────────────────────────────────────
  const now = new Date().toISOString()
  const categoryIds = {}
  {
    const batch = db.batch()
    for (const name of categoryNames) {
      const ref = db.collection('categories').doc()
      categoryIds[name] = ref.id
      batch.set(ref, {
        name,
        slug: name.toLowerCase().replace(/\s+/g, '-'),
        isActive: true,
        createdAt: now,
        updatedAt: now,
      })
    }
    await batch.commit()
  }

  // ── Items ─────────────────────────────────────────────────────────────────
  const rows = [
    ...STOCKED.map(([name, cat, price, stock, minStock, condition]) =>
      ({ name, cat, price, stock, minStock, condition, single: false, notes: '' })),
    ...SINGLES.map(([name, cat, price, condition, notes]) =>
      ({ name, cat, price, stock: 1, minStock: 0, condition, single: true, notes })),
  ]

  const skuCounters = {}
  let barcodeSeq = 0
  const batch = db.batch()
  for (const r of rows) {
    const code = CATEGORY_CODES[r.cat] || r.cat.slice(0, 3).toUpperCase()
    const prefix = `${code}-${r.condition === 'New' ? 'N' : 'R'}`
    skuCounters[prefix] = (skuCounters[prefix] || 0) + 1
    barcodeSeq += 1
    const barcode = String(barcodeSeq).padStart(6, '0')
    const ref = db.collection('inventory').doc()

    batch.set(ref, {
      id: ref.id,
      name: r.name,
      categoryId: categoryIds[r.cat],
      categoryName: r.cat,
      category: r.cat,
      price: r.price,
      quantity: r.stock,
      stock: r.stock,
      reservedStock: 0,
      barcode,
      minStock: r.minStock,
      condition: r.condition,
      status: r.condition,
      sku: `${prefix}-${String(skuCounters[prefix]).padStart(3, '0')}`,
      description: '',
      imageUrl: '',
      isSingleItem: r.single,
      conditionNotes: r.notes,
      stockStatus: stockStatusOf(r.stock, r.minStock),
      isDeleted: false,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    })

    const summary = (stock) => `Stock: ${stock}, Reserved: 0, Condition: ${r.condition}`
    batch.set(db.collection('stockLogs').doc(), {
      createdAt: FieldValue.serverTimestamp(),
      actionType: 'item_added',
      itemId: ref.id,
      itemName: r.name,
      condition: r.condition,
      quantityBefore: 0,
      quantityChanged: r.stock,
      quantityAfter: r.stock,
      stockBefore: 0,
      stockAfter: r.stock,
      reservedBefore: 0,
      reservedAfter: 0,
      previousValue: summary(0),
      newValue: summary(r.stock),
      userName: SETUP_USER.name,
      userEmail: SETUP_USER.email,
      userId: SETUP_USER.uid,
      remarks: r.single ? 'Single item added.' : 'New inventory variant created.',
      relatedId: '',
    })
  }
  // Barcode counter continues after the last code issued here.
  batch.set(
    db.collection('transactionCounters').doc('itemBarcode'),
    { sequence: barcodeSeq, updatedAt: now },
    { merge: true }
  )
  await batch.commit()

  console.log(`\nCreated ${categoryNames.length} categories and ${rows.length} items ` +
    `(${SINGLES.length} single items).`)
  console.log('Next: node scripts/simulate-sales-from-history.js --confirm')
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err.message || err)
    process.exit(1)
  })
