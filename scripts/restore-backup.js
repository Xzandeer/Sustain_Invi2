// Restore a SUSTAIN backup file into Firestore.
//
//   node scripts/restore-backup.js sustain-backup-2026-10-09.json
//       Dry run. Shows what is in the file and what would be written.
//       Nothing is changed.
//
//   node scripts/restore-backup.js sustain-backup-2026-10-09.json --confirm
//       Writes the backup into the database.
//
//   ... --confirm --only=inventory,categories
//       Restores only the named collections.
//
// WHAT A RESTORE DOES
//   Every document in the file is written back under its original ID,
//   replacing whatever is currently stored under that ID.
//
// WHAT IT DOES NOT DO
//   It does not delete documents that are in the database but not in the file.
//   A sale recorded after the backup was taken survives the restore. That is
//   deliberate - a restore should never silently destroy newer records - but it
//   means the database after a restore is "the backup plus anything newer",
//   not an exact copy of the backup.
//
// It also does not restore login accounts. Passwords live in Firebase
// Authentication, not Firestore, and are never in a backup file. The users
// collection restores each person's role and permissions; the person must still
// exist as an account to sign in.
//
// Credentials: serviceAccountKey.json if present, otherwise .env.local
// (see scripts/lib/adminDb.js). Run it against the right project: the project ID is printed first.

const fs = require('fs')
const path = require('path')

const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith('--'))
const confirm = args.includes('--confirm')
const onlyArg = args.find((a) => a.startsWith('--only='))
const only = onlyArg ? onlyArg.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean) : null

if (!file) {
  console.error('Usage: node scripts/restore-backup.js <backup-file.json> [--confirm] [--only=a,b]')
  process.exit(1)
}

const { db, projectId, FieldValue, Timestamp } = require('./lib/adminDb')

// Must match lib/server/backup.ts.
const TS_TAG = '__timestamp'
function deserialize(value) {
  if (Array.isArray(value)) return value.map(deserialize)
  if (value && typeof value === 'object') {
    const keys = Object.keys(value)
    if (keys.length === 1 && keys[0] === TS_TAG && typeof value[TS_TAG] === 'string') {
      return Timestamp.fromDate(new Date(value[TS_TAG]))
    }
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = deserialize(v)
    return out
  }
  return value
}

async function main() {
  const raw = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'))
  if (raw.format !== 'sustain-backup' || !raw.collections) {
    throw new Error('This is not a SUSTAIN backup file.')
  }

  const names = Object.keys(raw.collections).filter((n) => !only || only.includes(n))
  if (only) {
    const unknown = only.filter((n) => !raw.collections[n])
    if (unknown.length) throw new Error(`Not in this backup: ${unknown.join(', ')}`)
  }

  console.log(`Project:     ${projectId}`)
  console.log(`Backup from: ${raw.exportedAt}`)
  console.log(`Mode:        ${confirm ? 'RESTORE (writing)' : 'dry run (nothing will be written)'}`)
  console.log('')
  for (const n of names) {
    console.log(`  ${n.padEnd(22)} ${Object.keys(raw.collections[n]).length} documents`)
  }
  console.log('')

  if (!confirm) {
    console.log('Dry run only. Add --confirm to write these documents.')
    return
  }

  let written = 0
  for (const n of names) {
    const entries = Object.entries(raw.collections[n])
    // Firestore allows 500 writes per batch.
    for (let i = 0; i < entries.length; i += 400) {
      const batch = db.batch()
      for (const [id, data] of entries.slice(i, i + 400)) {
        batch.set(db.collection(n).doc(id), deserialize(data))
      }
      await batch.commit()
      written += Math.min(400, entries.length - i)
    }
    console.log(`  restored ${n}`)
  }
  console.log(`\nDone. ${written} documents written.`)
}

main().catch((err) => {
  console.error('Restore failed:', err.message)
  process.exit(1)
})
