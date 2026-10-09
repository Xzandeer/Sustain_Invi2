// GET /api/admin/backup - download a complete copy of the store's data.
//
// Administrator only. The file holds every sale, every customer name and
// contact number on a reservation, and every staff account, so it is the most
// sensitive thing the system can produce. Keep downloaded copies somewhere
// only the owner can reach.
//
// The file can be loaded back with scripts/restore-backup.js. See that script
// for what a restore does and does not overwrite.

import { NextResponse, type NextRequest } from 'next/server'
import { getAdminDb } from '@/lib/firebaseAdmin'
import { requireAdminRequest, verifiedUid } from '@/lib/server/authorize'
import {
  BACKUP_COLLECTIONS,
  BACKUP_FORMAT_VERSION,
  serializeValue,
  type BackupFile,
} from '@/lib/server/backup'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const denied = await requireAdminRequest(req)
  if (denied) return denied

  try {
    const db = getAdminDb()
    const uid = (await verifiedUid(req)) ?? 'unknown'

    const collections: BackupFile['collections'] = {}
    const counts: BackupFile['counts'] = {}

    for (const name of BACKUP_COLLECTIONS) {
      const snap = await db.collection(name).get()
      const docs: Record<string, unknown> = {}
      snap.docs.forEach((d) => {
        docs[d.id] = serializeValue(d.data())
      })
      collections[name] = docs
      counts[name] = snap.size
    }

    const now = new Date()
    const file: BackupFile = {
      format: 'sustain-backup',
      version: BACKUP_FORMAT_VERSION,
      exportedAt: now.toISOString(),
      exportedBy: uid,
      counts,
      collections,
    }

    // Recorded so the owner can see when backups were taken and by whom.
    await db.collection('storeSettings').doc('general').set(
      { lastBackupAt: now.toISOString(), lastBackupBy: uid },
      { merge: true }
    )

    const stamp = now.toISOString().slice(0, 10)
    return new NextResponse(JSON.stringify(file), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="sustain-backup-${stamp}.json"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (error) {
    console.error('[admin/backup] error:', error)
    return NextResponse.json({ error: 'Backup failed. No file was produced.' }, { status: 500 })
  }
}
