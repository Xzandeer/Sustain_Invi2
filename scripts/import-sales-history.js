// Import the store's notebook sales history (scaled) into Firestore.
//
//   node scripts/import-sales-history.js
//       Dry run. Shows the date range and totals that would be written.
//       Nothing is changed.
//
//   node scripts/import-sales-history.js --confirm
//       Writes the history into the `salesHistory` collection.
//
//   node scripts/import-sales-history.js --confirm --start=2026-08-01
//       Replays the notebook starting on that date (see DATES below).
//
//   node scripts/import-sales-history.js --confirm --end=2026-12-15
//       Same, but positioned so the LAST notebook day falls on that date.
//
//   node scripts/import-sales-history.js --remove
//       Deletes every imported history record (and nothing else).
//
// WHAT THIS DATA IS
//   Daily sales totals from the owner's handwritten notebook, already scaled by
//   an undisclosed constant for confidentiality (scripts/data/, not committed).
//   They are DAILY TOTALS ONLY - the notebook does not say which items were sold,
//   so no sale transactions, receipts or item records are created from them.
//
// DATES
//   Without --start, each day is imported on its real date (January to August
//   2026). Nothing is moved, copied or invented.
//
//   With --start=YYYY-MM-DD the whole notebook is moved forward so that its
//   first day (January 1) falls on that date. With --end=YYYY-MM-DD it is moved
//   so that its last day falls on that date instead. Every day keeps its real value and
//   its place in the sequence; nothing is copied or made up. Days after today
//   are stored but stay hidden - the app only shows imported days up to today -
//   so a new notebook day appears each day, through December and beyond, until
//   the notebook runs out. Each record keeps its real date in originalDateKey,
//   and the Analytics chart says the dates were moved for demonstration.
//
// USE A DEMO OR TEST PROJECT
//   On the dates it covers, imported history replaces recorded sales in the
//   sales trend chart (and the forecast, while those dates are recent). Do not import it into the database the
//   store uses for real selling. The project ID is printed first - check it.
//
// Credentials: serviceAccountKey.json if present, otherwise .env.local
// (see scripts/lib/adminDb.js).

const path = require('path')

const args = process.argv.slice(2)
const confirm = args.includes('--confirm')
const remove = args.includes('--remove')
const startArg = args.find((a) => a.startsWith('--start='))
const startKey = startArg ? startArg.slice('--start='.length) : null
const endArg = args.find((a) => a.startsWith('--end='))
const endKey = endArg ? endArg.slice('--end='.length) : null
for (const [flag, value] of [['--start', startKey], ['--end', endKey]]) {
  if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    console.error(`${flag} must be a date like 2026-12-15`)
    process.exit(1)
  }
}
if (startKey && endKey) {
  console.error('Use either --start or --end, not both.')
  process.exit(1)
}

const DAY_MS = 24 * 60 * 60 * 1000
// Dates as UTC midnights, so adding days never drifts across timezones.
const parseKey = (key) => {
  const [y, m, d] = key.split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}
const toKey = (ms) => new Date(ms).toISOString().slice(0, 10)

const COLLECTION = 'salesHistory'
const DATA_FILE = path.resolve(__dirname, 'data/sales-history-scaled.json')

const { db, projectId, FieldValue, Timestamp } = require('./lib/adminDb')

async function deleteAll() {
  let deleted = 0
  for (;;) {
    const snap = await db.collection(COLLECTION).limit(400).get()
    if (snap.empty) break
    const batch = db.batch()
    snap.docs.forEach((d) => batch.delete(d.ref))
    await batch.commit()
    deleted += snap.size
  }
  return deleted
}

async function main() {
  console.log(`Project: ${projectId}`)

  if (remove) {
    const deleted = await deleteAll()
    console.log(`Removed ${deleted} imported history record(s) from "${COLLECTION}".`)
    return
  }

  const data = require(DATA_FILE)
  const days = [...data.days].sort((a, b) => a.date.localeCompare(b.date))
  if (days.length === 0) throw new Error('The data file has no days.')

  // The notebook begins on January 1 of its year (that day had no sale, so the
  // first stored day may be later). --start maps January 1 onto the given date.
  const notebookStart = `${days[0].date.slice(0, 4)}-01-01`
  const shiftDays = startKey
    ? Math.round((parseKey(startKey) - parseKey(notebookStart)) / DAY_MS)
    : endKey
      ? Math.round((parseKey(endKey) - parseKey(days[days.length - 1].date)) / DAY_MS)
      : 0

  const records = days
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date))
    .map((d) => ({
      dateKey: toKey(parseKey(d.date) + shiftDays * DAY_MS),
      originalDateKey: d.date,
      shiftDays,
      total: Math.max(0, Number(d.total) || 0),
    }))

  const total = records.reduce((s, r) => s + r.total, 0)
  console.log(`Days with sales : ${records.length}`)
  console.log(`Notebook dates  : ${records[0].originalDateKey} to ${records[records.length - 1].originalDateKey}`)
  if (shiftDays) {
    console.log(`Shown as        : ${records[0].dateKey} to ${records[records.length - 1].dateKey} (moved ${shiftDays} days)`)
    console.log('                  Days after today stay hidden until their date.')
  }
  console.log(`Total (scaled)  : ${total.toLocaleString('en-PH', { maximumFractionDigits: 0 })}`)

  if (!confirm) {
    console.log('\nDry run - nothing written. Add --confirm to import.')
    return
  }

  // Start clean so a re-run never leaves stale records behind.
  const removed = await deleteAll()
  if (removed) console.log(`Cleared ${removed} previous history record(s).`)

  for (let i = 0; i < records.length; i += 400) {
    const batch = db.batch()
    for (const r of records.slice(i, i + 400)) {
      batch.set(db.collection(COLLECTION).doc(r.dateKey), {
        ...r,
        source: data.source || 'notebook-scaled',
        importedAt: FieldValue.serverTimestamp(),
      })
    }
    await batch.commit()
  }
  console.log(`\nImported ${records.length} day(s) into "${COLLECTION}".`)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err.message || err)
    process.exit(1)
  })
