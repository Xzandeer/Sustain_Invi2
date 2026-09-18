// Server-side reader for store-wide settings (Firestore: storeSettings/general).
// Falls back to the built-in default when the document or field is missing.

import { doc, getDoc } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import {
  DEFAULT_RESERVATION_DAYS,
  DEFAULT_WARRANTY_DAYS,
  DEFAULT_SELLER_ADDRESS,
  DEFAULT_SELLER_REGISTERED_NAME,
  DEFAULT_SELLER_TIN,
  SETTINGS_COLLECTION,
  SETTINGS_DOC,
} from '@/lib/constants/warranty'

export interface StoreSettings {
  warrantyDays: number
  /** Days a reservation holds stock before it lapses. */
  reservationDays: number
  /** Seller details printed on the sales invoice. See constants/warranty.ts. */
  sellerRegisteredName: string
  sellerTin: string
  sellerAddress: string
}

const str = (value: unknown, fallback: string) =>
  typeof value === 'string' && value.trim() ? value.trim() : fallback

const FALLBACK: StoreSettings = {
  warrantyDays: DEFAULT_WARRANTY_DAYS,
  reservationDays: DEFAULT_RESERVATION_DAYS,
  sellerRegisteredName: DEFAULT_SELLER_REGISTERED_NAME,
  sellerTin: DEFAULT_SELLER_TIN,
  sellerAddress: DEFAULT_SELLER_ADDRESS,
}

export async function getStoreSettings(): Promise<StoreSettings> {
  try {
    const snap = await getDoc(doc(db, SETTINGS_COLLECTION, SETTINGS_DOC))
    if (!snap.exists()) return { ...FALLBACK }

    const data = snap.data() as Record<string, unknown>
    const raw = data.warrantyDays
    const parsed =
      typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN

    const rawReservation = data.reservationDays
    const parsedReservation =
      typeof rawReservation === 'number'
        ? rawReservation
        : typeof rawReservation === 'string'
          ? Number(rawReservation)
          : Number.NaN

    return {
      warrantyDays:
        Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_WARRANTY_DAYS,
      reservationDays:
        Number.isFinite(parsedReservation) && parsedReservation >= 1
          ? Math.floor(parsedReservation)
          : DEFAULT_RESERVATION_DAYS,
      sellerRegisteredName: str(data.sellerRegisteredName, DEFAULT_SELLER_REGISTERED_NAME),
      sellerTin: str(data.sellerTin, DEFAULT_SELLER_TIN),
      sellerAddress: str(data.sellerAddress, DEFAULT_SELLER_ADDRESS),
    }
  } catch {
    // Firestore unavailable — fail safe to the built-in defaults
    return { ...FALLBACK }
  }
}

export async function getWarrantyDays(): Promise<number> {
  return (await getStoreSettings()).warrantyDays
}

export async function getReservationDays(): Promise<number> {
  return (await getStoreSettings()).reservationDays
}
