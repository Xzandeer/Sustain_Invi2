'use client'

// Restore from a backup file, inside the app (Settings > Data Backup).
//
// 1. The owner picks a backup file. It is read in the browser and checked.
// 2. A preview lists what is in it; the owner chooses which parts to restore.
// 3. Typing RESTORE unlocks the button - an overwrite should never be one
//    accidental click away.
// 4. Records are sent to /api/admin/restore in small chunks, with progress.
//
// Records added after the backup are never deleted. Staff accounts are not
// restored here (see RESTORABLE_COLLECTIONS in lib/server/backup.ts).

import { useMemo, useState } from 'react'
import { apiFetch } from '@/lib/apiFetch'

const CHUNK = 200

// Restored in this order so categories exist before the items that use them.
const ORDER = [
  'categories', 'inventory', 'reservations', 'sales', 'receipts', 'stockLogs',
  'storeSettings', 'transactionCounters', 'salesHistory', 'forecastEvents',
] as const

const LABELS: Record<string, string> = {
  categories: 'Categories',
  inventory: 'Inventory items',
  reservations: 'Reservations',
  sales: 'Sales',
  receipts: 'Receipts',
  stockLogs: 'Stock logs',
  storeSettings: 'Store settings',
  transactionCounters: 'Receipt and barcode counters',
  salesHistory: 'Notebook sales history',
  forecastEvents: 'Forecast notes',
  users: 'Staff accounts',
}

interface BackupFile {
  format: string
  exportedAt?: string
  collections: Record<string, Record<string, unknown>>
}

export default function RestoreBackup({ onDownloadBackup }: { onDownloadBackup: () => void }) {
  const [fileName, setFileName] = useState('')
  const [backup, setBackup] = useState<BackupFile | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirmText, setConfirmText] = useState('')
  const [phase, setPhase] = useState<'idle' | 'restoring' | 'done' | 'error'>('idle')
  const [progress, setProgress] = useState({ done: 0, total: 0, current: '' })
  const [message, setMessage] = useState('')

  const counts = useMemo(() => {
    const out: Record<string, number> = {}
    if (backup) for (const [k, v] of Object.entries(backup.collections)) out[k] = Object.keys(v ?? {}).length
    return out
  }, [backup])

  const totalSelected = useMemo(
    () => Array.from(selected).reduce((sum, c) => sum + (counts[c] ?? 0), 0),
    [selected, counts]
  )

  const reset = () => {
    setFileName(''); setBackup(null); setSelected(new Set()); setConfirmText('')
    setPhase('idle'); setProgress({ done: 0, total: 0, current: '' }); setMessage('')
  }

  const handleFile = async (file: File | undefined) => {
    reset()
    if (!file) return
    try {
      const parsed = JSON.parse(await file.text()) as BackupFile
      if (parsed?.format !== 'sustain-backup' || typeof parsed.collections !== 'object') {
        setPhase('error'); setMessage('This is not a SUSTAIN backup file.'); return
      }
      setFileName(file.name)
      setBackup(parsed)
      setSelected(new Set(ORDER.filter((c) => Object.keys(parsed.collections[c] ?? {}).length > 0)))
    } catch {
      setPhase('error'); setMessage('The file could not be read. Choose the .json file downloaded from Data Backup.')
    }
  }

  const toggle = (c: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(c)) next.delete(c); else next.add(c)
      return next
    })

  const runRestore = async () => {
    if (!backup || confirmText !== 'RESTORE' || selected.size === 0) return
    setPhase('restoring'); setMessage('')
    const plan = ORDER.filter((c) => selected.has(c))
    const total = plan.reduce((s, c) => s + (counts[c] ?? 0), 0)
    let done = 0
    const summary: Record<string, number> = {}
    setProgress({ done, total, current: '' })

    try {
      for (const collection of plan) {
        const entries = Object.entries(backup.collections[collection] ?? {})
        for (let i = 0; i < entries.length; i += CHUNK) {
          setProgress({ done, total, current: LABELS[collection] ?? collection })
          const res = await apiFetch('/api/admin/restore', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ collection, docs: Object.fromEntries(entries.slice(i, i + CHUNK)) }),
          })
          const data = (await res.json().catch(() => ({}))) as { error?: string; written?: number }
          if (!res.ok) throw new Error(`${LABELS[collection] ?? collection}: ${data.error ?? 'restore failed'}`)
          done += data.written ?? 0
          summary[collection] = (summary[collection] ?? 0) + (data.written ?? 0)
        }
      }
      await apiFetch('/api/admin/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ finalize: true, summary }),
      }).catch(() => {})
      setProgress({ done, total, current: '' })
      setPhase('done')
      setMessage(`Restored ${done.toLocaleString()} records. Reload the other pages to see them.`)
    } catch (e) {
      setPhase('error')
      setMessage(`${e instanceof Error ? e.message : 'Restore failed.'} ${done.toLocaleString()} of ${total.toLocaleString()} records were restored before it stopped.`)
    }
  }

  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0
  const restoring = phase === 'restoring'

  return (
    <div className="space-y-4 border-t border-slate-100 pt-5">
      <div>
        <h3 className="text-sm font-bold text-slate-900">Restore from a backup</h3>
        <p className="mt-0.5 text-sm text-slate-500">
          Put records back from a backup file if they were lost or changed by mistake.
        </p>
      </div>

      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-900">
        Restoring replaces the current copy of each record with the one in the file. Records added after the
        backup are kept. Download a fresh backup first so you can undo this if needed.
        <button
          type="button"
          onClick={onDownloadBackup}
          className="ml-1 font-semibold underline underline-offset-2 hover:text-amber-950"
        >
          Download a backup now
        </button>
      </div>

      {/* Step 1: choose file */}
      <label className="block">
        <span className="mb-1.5 block text-xs font-semibold text-slate-600">Backup file (.json)</span>
        <input
          type="file"
          accept=".json,application/json"
          disabled={restoring}
          onChange={(e) => handleFile(e.target.files?.[0])}
          className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-200"
        />
      </label>

      {/* Step 2: preview and choose */}
      {backup && (
        <div className="rounded-lg border border-slate-200">
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-100 px-4 py-2.5">
            <p className="text-sm font-semibold text-slate-800">{fileName}</p>
            <p className="text-xs text-slate-500">
              Backed up{' '}
              {backup.exportedAt
                ? new Date(backup.exportedAt).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' })
                : 'at an unknown time'}
            </p>
          </div>
          <ul className="divide-y divide-slate-50">
            {ORDER.map((c) => (
              <li key={c} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                <label className="flex items-center gap-2.5 text-slate-700">
                  <input
                    type="checkbox"
                    checked={selected.has(c)}
                    disabled={restoring || !(counts[c] > 0)}
                    onChange={() => toggle(c)}
                    className="h-4 w-4 rounded border-slate-300"
                  />
                  {LABELS[c]}
                </label>
                <span className="tabular-nums text-xs text-slate-500">{(counts[c] ?? 0).toLocaleString()}</span>
              </li>
            ))}
            {counts.users > 0 && (
              <li className="flex items-center justify-between gap-3 px-4 py-2 text-sm text-slate-400">
                <span>{LABELS.users} (not restored here; manage them on the Users page)</span>
                <span className="tabular-nums text-xs">{counts.users.toLocaleString()}</span>
              </li>
            )}
          </ul>
          <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">
            {totalSelected.toLocaleString()} records selected.
            {totalSelected > 15000 && ' This is close to the free daily database write limit (20,000); consider restoring in parts.'}
          </p>
        </div>
      )}

      {/* Step 3: confirm */}
      {backup && phase !== 'done' && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold text-slate-600">Type RESTORE to confirm</span>
            <input
              type="text"
              value={confirmText}
              disabled={restoring}
              onChange={(e) => setConfirmText(e.target.value.toUpperCase())}
              placeholder="RESTORE"
              className="w-40 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 focus:border-blue-400 focus:outline-none"
            />
          </label>
          <button
            type="button"
            onClick={runRestore}
            disabled={restoring || confirmText !== 'RESTORE' || selected.size === 0}
            className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {restoring ? 'Restoring…' : 'Restore selected'}
          </button>
        </div>
      )}

      {/* Step 4: progress and result */}
      {(restoring || phase === 'done' || (phase === 'error' && progress.total > 0)) && (
        <div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
            <div
              className={`h-full rounded-full transition-all ${phase === 'error' ? 'bg-rose-500' : 'bg-emerald-500'}`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="mt-1 text-xs text-slate-500">
            {progress.done.toLocaleString()} of {progress.total.toLocaleString()} records
            {restoring && progress.current ? ` · restoring ${progress.current}` : ''}
          </p>
        </div>
      )}

      {message && (
        <p className={`rounded-lg px-4 py-2 text-sm ${phase === 'done' ? 'bg-emerald-50 text-emerald-800' : 'bg-rose-50 text-rose-700'}`}>
          {message}
        </p>
      )}

      {phase === 'done' && (
        <button type="button" onClick={reset} className="text-sm font-medium text-blue-600 hover:underline">
          Restore another file
        </button>
      )}
    </div>
  )
}
