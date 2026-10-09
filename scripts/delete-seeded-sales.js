// Delete the demonstration sales created by the seed scripts, and the simulated
// sales made by simulate-sales-from-history.js (simulated@jmgs.local).
//
//   node scripts/delete-seeded-sales.js
//       Dry run. Counts what would be deleted and what would be kept.
//       Nothing is changed.
//
//   node scripts/delete-seeded-sales.js --confirm
//       Permanently deletes the seeded sales.
//
// HOW A SEEDED SALE IS RECOGNISED
//   seed-year.js and seed-two-months.js record every sale under one of three
//   made-up staff accounts whose email ends in @jmgs.local (Maria Santos, Ramon
//   Cruz, Store Administrator). Real sales carry the email of the account that
//   rang them up. Only sales with an @jmgs.local email are deleted; everything
//   else is kept and listed in the dry run so you can check it.
//
// WHAT IT DOES NOT TOUCH
//   Only the `sales` collection. Inventory, categories, reservations, stock logs,
//   receipts, users and the imported notebook history are left as they are.
//   Seeded stock-log lines that mention a deleted sale stay in the log.
//
// THIS CANNOT BE UNDONE. Download a backup first (Settings -> Data Backup).

const { db, projectId } = require('./lib/adminDb')

const confirm = process.argv.slice(2).includes('--confirm')
const SEED_EMAIL = /@jmgs\.local$/i

const toDate = (v) => (v && typeof v.toDate === 'function' ? v.toDate() : v ? new Date(v) : null)
const dayKey = (d) => (d && !isNaN(d) ? d.toISOString().slice(0, 10) : 'no date')

async function main() {
  console.log(`Project: ${projectId}\n`)

  const snap = await db.collection('sales').get()
  const seeded = []
  const kept = new Map() // who -> count

  snap.docs.forEach((doc) => {
    const data = doc.data()
    const email = String(data.processedByEmail || '')
    if (SEED_EMAIL.test(email)) {
      seeded.push({ ref: doc.ref, at: toDate(data.createdAt) })
    } else {
      const who = data.processedByName || data.cashierName || email || '(unknown)'
      kept.set(who, (kept.get(who) || 0) + 1)
    }
  })

  const dates = seeded.map((s) => dayKey(s.at)).filter((k) => k !== 'no date').sort()
  console.log(`Seeded sales to delete : ${seeded.length}`)
  if (dates.length) console.log(`  dated                : ${dates[0]} to ${dates[dates.length - 1]}`)
  console.log(`Other sales kept       : ${snap.size - seeded.length}`)
  kept.forEach((n, who) => console.log(`  ${who}: ${n}`))

  if (!confirm) {
    console.log('\nDry run - nothing deleted. Check the kept list above, then add --confirm.')
    return
  }
  if (seeded.length === 0) {
    console.log('\nNothing to delete.')
    return
  }

  let done = 0
  for (let i = 0; i < seeded.length; i += 400) {
    const batch = db.batch()
    seeded.slice(i, i + 400).forEach((s) => batch.delete(s.ref))
    await batch.commit()
    done += Math.min(400, seeded.length - i)
    process.stdout.write(`\rDeleted ${done} / ${seeded.length}`)
  }
  console.log('\nDone.')
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err.message || err)
    process.exit(1)
  })
