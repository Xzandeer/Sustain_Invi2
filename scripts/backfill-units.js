// Moves existing stock onto the one-condition-scale model (lib/inventory/units.ts).
//
//   node scripts/backfill-units.js
//       Dry run. Shows what would change, including any shelf price changes.
//       Nothing is written.
//
//   node scripts/backfill-units.js --confirm
//       Applies it.
//
//   node scripts/backfill-units.js --confirm --keep-quantity=<id>,<id>
//       Leaves the listed items counted only (identical bulk goods).
//
// FOR EACH ITEM (name + category), not in the trash, not yet migrated:
//   - New and Refurbished records of the same item become ONE item. The New
//     record is kept; the other is emptied, moved to the trash and marked
//     mergedInto, so its old barcode labels still scan to the kept item.
//   - one unit per piece in stock, each with its own 8-digit code:
//       pieces from a New record      -> condition "New"
//       pieces from a Refurbished one -> condition "Good"
//     A single item's condition notes are copied onto its piece.
//   - base price: the New record's price. An item with only a Refurbished
//     record gets the base price at which a Good piece sells for what it
//     sells for today.
//   - pieces held by an Active reservation become `reserved` units linked to
//     it; the reservation's lines are moved to the kept item.
// Sales history and stock logs are not touched, so past reports keep their
// New / Refurbished split.
//
// Safe to run again: items already migrated are skipped.
//
// Runs only against a project whose ID contains "demo" or "test" unless
// --i-have-a-backup is passed. Download a backup from Settings first anyway.

const { db, projectId } = require('./lib/adminDb')

const args = process.argv.slice(2)
const confirm = args.includes('--confirm')
const allowAnyProject = args.includes('--i-have-a-backup')
const keepQuantity = new Set(
  (args.find((a) => a.startsWith('--keep-quantity=')) || '').replace('--keep-quantity=', '').split(',').filter(Boolean)
)

if (!/demo|test/i.test(projectId) && !allowAnyProject) {
  console.error(`Refusing to run: project "${projectId}" is not a demo or test project.`)
  console.error('Download a backup from Settings, then re-run with --i-have-a-backup.')
  process.exit(1)
}

// Keep in step with DEFAULT_GRADE_PRICING in lib/inventory/units.ts.
const DEFAULT_PRICING = { 'New': 100, 'Excellent': 90, 'Very Good': 80, 'Good': 70, 'Fair': 50, 'For parts': 25 }

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0)
const norm = (v) => String(v || '').trim().replace(/\s+/g, ' ').toLowerCase()
const peso = (n) => '₱' + Math.round(n).toLocaleString('en-PH')

async function reserveCodes(count) {
  if (count === 0) return []
  const ref = db.collection('transactionCounters').doc('unitCode')
  let first = 1
  await db.runTransaction(async (txn) => {
    const snap = await txn.get(ref)
    const current = snap.exists ? num(snap.data().sequence) : 0
    first = current > 0 ? current + 1 : 1
    txn.set(ref, { sequence: first + count - 1, updatedAt: new Date().toISOString() }, { merge: true })
  })
  return Array.from({ length: count }, (_, i) => String(first + i).padStart(8, '0'))
}

async function main() {
  console.log(`Project: ${projectId}${confirm ? '' : '  (dry run - add --confirm to write)'}`)

  const [inventorySnap, reservationSnap, settingsSnap] = await Promise.all([
    db.collection('inventory').get(),
    db.collection('reservations').where('status', '==', 'Active').get(),
    db.collection('storeSettings').doc('general').get(),
  ])
  const pricing = { ...DEFAULT_PRICING, ...((settingsSnap.exists && settingsSnap.data().gradePricing) || {}) }
  const goodShare = pricing['Good'] / 100

  // ── Group records into items ──
  const groups = new Map() // key -> [doc]
  for (const doc of inventorySnap.docs) {
    const d = doc.data()
    if (d.isDeleted === true) continue
    // A single item is one piece of its own; it is never merged.
    const key = d.isSingleItem === true ? `single:${doc.id}` : `${d.categoryId || ''}|${norm(d.name)}`
    groups.set(key, [...(groups.get(key) || []), doc])
  }

  const plan = []
  for (const docs of groups.values()) {
    // Already on the new model: migrated, or created by Receive stock (which
    // always sets trackingMode).
    if (docs.every((doc) => doc.data().migratedToScale === true || typeof doc.data().trackingMode === 'string')) continue
    // Keep a record that already has its pieces; otherwise the New one.
    const primary = docs.find((doc) => doc.data().trackingMode === 'unit') ||
      docs.find((doc) => doc.data().condition !== 'Refurbished') || docs[0]
    const primaryData = primary.data()
    const quantityOnly = docs.some((doc) => keepQuantity.has(doc.id))
    const onlyRefurbished = docs.every((doc) => doc.data().condition === 'Refurbished')
    const oldPrice = num(primaryData.price)
    const basePrice = onlyRefurbished ? Math.round(oldPrice / goodShare) : oldPrice

    const sources = docs.map((doc) => {
      const d = doc.data()
      return {
        doc,
        d,
        stock: Math.max(0, Math.floor(num(d.stock ?? d.quantity))),
        reserved: Math.max(0, Math.floor(num(d.reservedStock))),
        grade: d.condition === 'Refurbished' ? 'Good' : 'New',
        // Its pieces exist already (Receive stock); only its count is merged.
        hasUnits: d.trackingMode === 'unit',
      }
    })

    // What each source's pieces will sell for after migration.
    const priceChanges = sources
      .map((s) => {
        const before = num(s.d.price)
        const after = Math.round((basePrice * pricing[s.grade]) / 100)
        return { name: s.d.name, condition: s.d.condition || 'New', before, after, stock: s.stock }
      })
      .filter((c) => c.stock > 0 && Math.abs(c.before - c.after) >= 1)

    plan.push({ primary, primaryData, sources, quantityOnly, basePrice, priceChanges, merged: docs.length > 1 })
  }

  const unitTotal = plan.filter((p) => !p.quantityOnly).reduce((s, p) => s + p.sources.reduce((a, x) => a + (x.hasUnits ? 0 : x.stock), 0), 0)
  console.log(`${plan.length} items. ${plan.filter((p) => p.merged).length} New/Refurbished pairs merged into one item.`)
  console.log(`${unitTotal} pieces get their own record; ${plan.filter((p) => p.quantityOnly).length} items stay counted only.`)
  for (const p of plan.filter((x) => x.merged).slice(0, 10)) {
    console.log(`  merge  ${p.primaryData.name}: ${p.sources.map((s) => `${s.stock} ${s.d.condition || 'New'}`).join(' + ')}`)
  }
  const changes = plan.flatMap((p) => p.priceChanges)
  if (changes.length) {
    console.log(`\nShelf prices that change with price by condition (New ${pricing['New']}%, Good ${pricing['Good']}%):`)
    for (const c of changes.slice(0, 25)) console.log(`  ${c.name} (${c.condition}, ${c.stock} pcs): ${peso(c.before)} -> ${peso(c.after)}`)
    if (changes.length > 25) console.log(`  ... and ${changes.length - 25} more`)
    console.log('Adjust Settings > Price by condition first, or re-price pieces under Units afterwards.')
  }

  if (!confirm) return

  // ── Write ──
  const codes = await reserveCodes(unitTotal)
  let codeIndex = 0
  const now = new Date().toISOString()

  // Which active reservation holds how many of each record.
  const holds = new Map() // record id -> [{ reservationId, quantity }]
  for (const r of reservationSnap.docs) {
    for (const line of Array.isArray(r.data().items) ? r.data().items : []) {
      const id = typeof line.id === 'string' ? line.id : ''
      const q = Math.max(0, Math.floor(num(line.quantity)))
      if (id && q) holds.set(id, [...(holds.get(id) || []), { reservationId: r.id, quantity: q }])
    }
  }
  const movedTo = new Map() // record id -> kept item id
  const reservedUnits = new Map() // `${reservationId}|${record id}` -> unit ids

  let batch = db.batch()
  let ops = 0
  const flush = async () => { if (ops > 0) { await batch.commit(); batch = db.batch(); ops = 0 } }
  const add = async (fn) => { fn(batch); ops++; if (ops >= 400) await flush() }

  for (const p of plan) {
    const primaryId = p.primary.id
    const grades = []
    for (const s of p.sources) {
      movedTo.set(s.doc.id, primaryId)
      if (p.quantityOnly || s.hasUnits) continue
      const itemHolds = (holds.get(s.doc.id) || []).map((h) => ({ ...h }))
      let reservedLeft = Math.min(s.stock, s.reserved)
      const notes = s.d.isSingleItem === true && typeof s.d.conditionNotes === 'string' ? s.d.conditionNotes : ''
      for (let i = 0; i < s.stock; i++) {
        const ref = db.collection('inventoryUnits').doc()
        let status = 'in_stock'
        let reservationId = null
        if (reservedLeft > 0 && itemHolds[0]) {
          status = 'reserved'
          reservationId = itemHolds[0].reservationId
          const key = `${reservationId}|${s.doc.id}`
          reservedUnits.set(key, [...(reservedUnits.get(key) || []), ref.id])
          itemHolds[0].quantity -= 1
          if (itemHolds[0].quantity === 0) itemHolds.shift()
          reservedLeft -= 1
        }
        grades.push(s.grade)
        const unitCode = codes[codeIndex++]
        await add((b) => b.set(ref, {
          id: ref.id,
          itemId: primaryId,
          itemName: p.primaryData.name || '',
          unitCode,
          grade: s.grade,
          conditionNotes: notes,
          priceOverride: null,
          status,
          receivedAt: typeof s.d.createdAt === 'string' ? s.d.createdAt : now,
          source: 'backfill',
          reservationId,
          saleId: null,
          soldAt: null,
          writtenOffAt: null,
          createdAt: now,
          updatedAt: now,
        }))
      }
    }

    const stock = p.sources.reduce((a, s) => a + s.stock, 0)
    const reserved = p.sources.reduce((a, s) => a + Math.min(s.stock, s.reserved), 0)
    const legacy = grades.length > 0 && grades.every((g) => g === 'New') ? 'New'
      : p.quantityOnly && p.sources.every((s) => s.grade === 'New') ? 'New' : 'Refurbished'
    await add((b) => b.update(p.primary.ref, {
      trackingMode: p.quantityOnly ? 'quantity' : 'unit',
      migratedToScale: true,
      price: p.basePrice,
      stock,
      quantity: stock,
      reservedStock: reserved,
      minStock: Math.max(...p.sources.map((s) => Math.max(0, num(s.d.minStock)))),
      condition: legacy,
      status: legacy,
      ...(p.quantityOnly ? { grade: p.sources[0].grade } : {}),
      updatedAt: now,
    }))
    for (const s of p.sources.filter((x) => x.doc.id !== primaryId)) {
      await add((b) => b.update(s.doc.ref, {
        mergedInto: primaryId,
        migratedToScale: true,
        stock: 0,
        quantity: 0,
        reservedStock: 0,
        isDeleted: true,
        deletedAt: now,
        updatedAt: now,
      }))
    }
  }

  // Active reservations: lines move to the kept item; two lines of one item become one.
  for (const r of reservationSnap.docs) {
    const lines = Array.isArray(r.data().items) ? r.data().items : []
    const merged = []
    for (const line of lines) {
      const oldId = typeof line.id === 'string' ? line.id : ''
      const id = movedTo.get(oldId) || oldId
      const unitIds = reservedUnits.get(`${r.id}|${oldId}`) || []
      const existing = merged.find((l) => l.id === id)
      if (existing) {
        existing.quantity = num(existing.quantity) + num(line.quantity)
        existing.unitIds = [...(existing.unitIds || []), ...unitIds]
      } else {
        merged.push({ ...line, id, ...(unitIds.length ? { unitIds } : {}) })
      }
    }
    await add((b) => b.update(r.ref, { items: merged }))
  }

  await flush()
  console.log(`\nDone. ${codeIndex} pieces created, ${plan.filter((p) => p.merged).length} pairs merged.`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
