// POST /api/admin/restore - write part of a backup file back into Firestore.
//
// Administrator only. The browser reads the backup file, lets the owner choose
// what to restore, and sends it here one collection-chunk at a time:
//
//   { collection: 'inventory', docs: { <id>: <record>, ... } }   (max 200)
//   { finalize: true, summary: { inventory: 312, ... } }          (once, at the end)
//
// The same rules as scripts/restore-backup.js:
//   - every record is written back under its original ID, replacing the
//     current copy; tagged dates become Firestore Timestamps again
//   - records that are not in the file are never deleted, so anything added
//     after the backup survives
//   - staff accounts are not restored here (see RESTORABLE_COLLECTIONS)
// One extra rule: transaction counters never go backwards. Restoring an old
// counter would make the next receipt reuse a number already printed.

import { NextResponse, type NextRequest } from 'next/server'
import { Timestamp } from 'firebase-admin/firestore'
import { getAdminDb } from '@/lib/firebaseAdmin'
import { requireAdminRequest, verifiedUid } from '@/lib/server/authorize'
import { RESTORABLE_COLLECTIONS, RESTORE_CHUNK_SIZE, deserializeValue } from '@/lib/server/backup'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const validId = (id: string) => id.length > 0 && id.length <= 1500 && !id.includes('/') && id !== '.' && id !== '..'

export async function POST(req: NextRequest) {
  const denied = await requireAdminRequest(req)
  if (denied) return denied

  try {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body) return NextResponse.json({ error: 'The request could not be read.' }, { status: 400 })
    const db = getAdminDb()

    // ── Final step: record that a restore happened, and by whom ─────────────
    if (body.finalize === true) {
      const uid = (await verifiedUid(req)) ?? 'unknown'
      await db.collection('storeSettings').doc('general').set(
        {
          lastRestoreAt: new Date().toISOString(),
          lastRestoreBy: uid,
          lastRestoreSummary: isPlainObject(body.summary) ? body.summary : {},
        },
        { merge: true }
      )
      return NextResponse.json({ success: true })
    }

    // ── A chunk of one collection ────────────────────────────────────────────
    const collection = typeof body.collection === 'string' ? body.collection : ''
    if (!(RESTORABLE_COLLECTIONS as readonly string[]).includes(collection)) {
      return NextResponse.json({ error: `"${collection}" cannot be restored here.` }, { status: 400 })
    }
    if (!isPlainObject(body.docs)) {
      return NextResponse.json({ error: 'No records were sent.' }, { status: 400 })
    }
    const entries = Object.entries(body.docs)
    if (entries.length > RESTORE_CHUNK_SIZE) {
      return NextResponse.json({ error: `Send at most ${RESTORE_CHUNK_SIZE} records at a time.` }, { status: 400 })
    }
    for (const [id, data] of entries) {
      if (!validId(id) || !isPlainObject(data)) {
        return NextResponse.json({ error: `Record "${id.slice(0, 40)}" in ${collection} is not valid.` }, { status: 400 })
      }
    }

    const toFirestore = (v: unknown) => deserializeValue(v, (d) => Timestamp.fromDate(d)) as Record<string, unknown>
    const batch = db.batch()

    if (collection === 'transactionCounters') {
      // Never move a counter backwards: keep the higher of current and backup
      // for every numeric field.
      const refs = entries.map(([id]) => db.collection(collection).doc(id))
      const current = refs.length ? await db.getAll(...refs) : []
      entries.forEach(([id, data], i) => {
        const restored = toFirestore(data)
        const now = (current[i]?.exists ? current[i].data() : {}) as Record<string, unknown>
        for (const [k, v] of Object.entries(now)) {
          if (typeof v === 'number' && typeof restored[k] === 'number') restored[k] = Math.max(v, restored[k] as number)
        }
        batch.set(db.collection(collection).doc(id), restored)
      })
    } else {
      for (const [id, data] of entries) {
        batch.set(db.collection(collection).doc(id), toFirestore(data))
      }
    }

    await batch.commit()
    return NextResponse.json({ success: true, written: entries.length })
  } catch (error) {
    console.error('[admin/restore] error:', error)
    const message = String((error as { message?: unknown })?.message ?? '')
    return NextResponse.json(
      {
        error: /RESOURCE_EXHAUSTED|quota/i.test(message)
          ? 'The database daily write limit was reached. Records written so far were kept; run the restore again after the limit resets.'
          : 'Restoring this part failed. Records written before it were kept.',
      },
      { status: 500 }
    )
  }
}
