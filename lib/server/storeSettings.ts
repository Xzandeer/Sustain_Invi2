// Server-side reader for store-wide settings (Firestore: storeSettings/general).
// Falls back to the built-in default when the document or field is missing.

import { doc, getDoc } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { DEFAULT_WARRANTY_DAYS, SETTINGS_COLLECTION, SETTINGS_DOC } from '@/lib/constants/warranty'

export interface StoreSettings {
  warrantyDays: number
}

export async function getStoreSettings(): Promise<StoreSettings> {
  try {
    const snap = await getDoc(doc(db, SETTINGS_COLLECTION, SETTINGS_DOC))
    if (!snap.exists()) return { warrantyDays: DEFAULT_WARRANTY_DAYS }

    const data = snap.data() as Record<string, unknown>
    const raw = data.warrantyDays
    const parsed =
      typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN

    if (!Number.isFinite(parsed) || parsed < 0) {
      return { warrantyDays: DEFAULT_WARRANTY_DAYS }
    }
    return { warrantyDays: Math.floor(parsed) }
  } catch {
    // Firestore unavailable — fail safe to the default policy
    return { warrantyDays: DEFAULT_WARRANTY_DAYS }
  }
}

export async function getWarrantyDays(): Promise<number> {
  return (await getStoreSettings()).warrantyDays
}
