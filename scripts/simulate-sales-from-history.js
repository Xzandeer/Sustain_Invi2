// Build SIMULATED sale transactions whose daily totals follow the imported
// notebook history, so item and category charts have something to show.
//
//   node scripts/simulate-sales-from-history.js
//       Dry run. Shows how many days and sales would be created.
//
//   node scripts/simulate-sales-from-history.js --confirm
//       Writes the simulated sales.
//
//   node scripts/delete-seeded-sales.js --confirm
//       Removes them again (they are recorded under simulated@jmgs.local).
//
// WHAT IS REAL AND WHAT IS NOT
//   Real:      each day's TOTAL comes from the store notebook (scaled), via the
//              salesHistory collection written by import-sales-history.js.
//   Simulated: which items and categories made up that total, how many
//              transactions there were, and at what time. The notebook does not
//              record any of this, so it is generated at random from the items
//              in inventory. Every simulated sale carries isSimulated: true and
//              the Analytics page says so. Do not present item or category
//              results from this data as the store's real performance.
//
// DETAILS
//   - Days up to and including today are filled. Re-run later to fill the days
//     that have arrived since; days that already have simulated sales are skipped.
//   - Stock is NOT deducted and no stock-log lines are written, so inventory
//     levels are unaffected.
//   - A day's simulated sales add up to the notebook total to within the price
//     of the cheapest item. On the sales chart and revenue card the notebook
//     total itself is used, so those figures stay exact.
//   - The random generator is seeded (--seed=N, default 7), so a run can be
//     repeated exactly.

const { db, projectId, Timestamp } = require('./lib/adminDb')

const args = process.argv.slice(2)
const confirm = args.includes('--confirm')
const seedArg = args.find((a) => a.startsWith('--seed='))
const SEED = seedArg ? Number(seedArg.split('=')[1]) || 7 : 7

const SIM_USER = { name: 'Simulated (notebook data)', email: 'simulated@jmgs.local' }

// mulberry32 - small seedable generator.
function createRng(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const random = createRng(SEED)
const randomInt = (min, max) => min + Math.floor(random() * (max - min + 1))

// Local calendar date in the Philippines as YYYY-MM-DD.
const manilaKey = (d) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d)

async function main() {
  console.log(`Project: ${projectId}\n`)

  // ── Items to draw from ────────────────────────────────────────────────────
  const invSnap = await db.collection('inventory').get()
  const items = invSnap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((i) => i.isDeleted !== true && i.isVoided !== true && i.isSingleItem !== true)
    .map((i) => ({
      id: i.id,
      name: String(i.name || 'Item'),
      price: Number(i.price) || 0,
      categoryId: String(i.categoryId || ''),
      categoryName: String(i.categoryName || i.category || 'Uncategorized'),
      condition: i.condition === 'Refurbished' ? 'Refurbished' : 'New',
    }))
    .filter((i) => i.price > 0)
  if (items.length === 0) throw new Error('No sellable inventory items found.')

  // Some items sell far more often than others. Give each a fixed popularity
  // so top sellers look like a shop, not a lottery.
  items.forEach((item) => { item.weight = Math.pow(random(), 2) + 0.05 })
  const pickItem = (maxPrice) => {
    const pool = items.filter((i) => i.price <= maxPrice)
    if (pool.length === 0) return null
    const w = pool.reduce((s, i) => s + i.weight, 0)
    let r = random() * w
    for (const item of pool) { r -= item.weight; if (r <= 0) return item }
    return pool[pool.length - 1]
  }
  const cheapest = Math.min(...items.map((i) => i.price))

  // ── Days to fill ──────────────────────────────────────────────────────────
  const todayKey = manilaKey(new Date())
  const histSnap = await db.collection('salesHistory').where('dateKey', '<=', todayKey).get()
  const days = histSnap.docs
    .map((d) => d.data())
    .filter((d) => typeof d.dateKey === 'string' && Number(d.total) > 0)
    .sort((a, b) => a.dateKey.localeCompare(b.dateKey))

  const simSnap = await db.collection('sales').where('isSimulated', '==', true).get()
  const alreadyDone = new Set(simSnap.docs.map((d) => d.data().dateKey))
  const todo = days.filter((d) => !alreadyDone.has(d.dateKey))

  // ── Build the transactions ────────────────────────────────────────────────
  const plan = []
  let plannedTotal = 0
  let notebookTotal = 0
  for (const day of todo) {
    const target = Number(day.total)
    notebookTotal += target
    let remaining = target
    const times = []
    const sales = []

    while (remaining >= cheapest) {
      // One customer: 1-3 different items, usually one of each.
      const lines = []
      const lineCount = randomInt(1, 3)
      for (let n = 0; n < lineCount && remaining >= cheapest; n += 1) {
        const item = pickItem(remaining)
        if (!item || lines.some((l) => l.item.id === item.id)) continue
        const maxQty = Math.max(1, Math.min(item.price > 900 ? 1 : 3, Math.floor(remaining / item.price)))
        const quantity = randomInt(1, maxQty)
        lines.push({ item, quantity })
        remaining -= item.price * quantity
      }
      if (lines.length === 0) break
      sales.push(lines)
      times.push(randomInt(9 * 60, 18 * 60)) // between 9:00 and 18:00
    }

    times.sort((a, b) => a - b)
    sales.forEach((lines, i) => {
      const total = lines.reduce((s, l) => s + l.item.price * l.quantity, 0)
      plannedTotal += total
      plan.push({ dateKey: day.dateKey, seq: i + 1, minute: times[i], lines, total })
    })
  }

  console.log(`Notebook days available      : ${days.length}`)
  console.log(`Already simulated (skipped)  : ${days.length - todo.length}`)
  console.log(`Days to fill now             : ${todo.length}${todo.length ? ` (${todo[0].dateKey} to ${todo[todo.length - 1].dateKey})` : ''}`)
  console.log(`Simulated sales to create    : ${plan.length}`)
  console.log(`Notebook total for those days: ${Math.round(notebookTotal).toLocaleString('en-PH')}`)
  console.log(`Simulated sales add up to    : ${Math.round(plannedTotal).toLocaleString('en-PH')}`)
  console.log(`Items drawn from             : ${items.length} inventory lines`)

  if (!confirm) {
    console.log('\nDry run - nothing written. Add --confirm to create the simulated sales.')
    return
  }

  let written = 0
  for (let i = 0; i < plan.length; i += 400) {
    const batch = db.batch()
    for (const p of plan.slice(i, i + 400)) {
      const hh = String(Math.floor(p.minute / 60)).padStart(2, '0')
      const mm = String(p.minute % 60).padStart(2, '0')
      const when = new Date(`${p.dateKey}T${hh}:${mm}:00+08:00`)
      const receipt = `SIM-${p.dateKey}-${String(p.seq).padStart(4, '0')}`
      const categories = Array.from(new Set(p.lines.map((l) => l.item.categoryName)))
      const ref = db.collection('sales').doc()
      batch.set(ref, {
        id: ref.id,
        receiptNumber: receipt,
        searchableNumber: receipt,
        transactionType: 'sale',
        dateKey: p.dateKey,
        sequenceNumber: p.seq,
        customerSearchEmail: '',
        items: p.lines.map((l) => ({
          itemId: l.item.id,
          name: l.item.name,
          quantity: l.quantity,
          price: l.item.price,
          categoryId: l.item.categoryId,
          categoryName: l.item.categoryName,
          condition: l.item.condition,
          warrantyDays: 7,
          status: 'completed',
          refundedQuantity: 0,
        })),
        categoryName: categories.join(', '),
        category: categories.join(', '),
        customer: '',
        customerName: '',
        customerEmail: '',
        customerContactNumber: '',
        totalAmount: p.total,
        quantity: p.lines.reduce((s, l) => s + l.quantity, 0),
        total: p.total,
        amount: p.total,
        status: 'Completed',
        warrantyDays: 7,
        processedByName: SIM_USER.name,
        processedByEmail: SIM_USER.email,
        isSimulated: true,
        simulationNote: 'Day total from the store notebook (scaled); items and categories simulated.',
        createdAt: Timestamp.fromDate(when),
        transactionDate: when.toISOString(),
      })
    }
    await batch.commit()
    written += Math.min(400, plan.length - i)
    process.stdout.write(`\rWritten ${written} / ${plan.length}`)
  }
  console.log('\nDone.')
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err.message || err)
    process.exit(1)
  })
