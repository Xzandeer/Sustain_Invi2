// Scan-to-sale: turning a scanned item code into a sale from any page.
//
// A scan (USB/Bluetooth scanner or the camera) reads the code printed on an
// item's label - a barcode or a QR code holding the same six digits. The code
// is checked against the inventory first, so only a real, sellable item ever
// opens the point of sale. The Sales page then reads ?scan=<code> and adds the
// item to the cart through its own barcode handler (the same path as scanning
// at the counter).

import { apiFetch } from '@/lib/apiFetch'

/** Query parameter the Sales page reads on open. */
export const SCAN_PARAM = 'scan'

/**
 * The item code inside whatever the scanner read. Labels carry digits only, but
 * a QR code may wrap them in other text, so everything but the digits is
 * dropped. Returns null when nothing code-like is left.
 */
export const extractItemCode = (raw: string): string | null => {
  const digits = raw.replace(/\D/g, '')
  return digits.length >= 4 ? digits : null
}

/**
 * Confirms the code belongs to a sellable inventory item.
 * Resolves with the item's name, or throws an Error with a readable reason
 * (unknown code, voided, in the trash, offline).
 */
export async function verifyItemCode(code: string): Promise<{ name: string }> {
  let res: Response
  try {
    res = await apiFetch(`/api/inventory/barcodes?code=${encodeURIComponent(code)}`)
  } catch {
    throw new Error('Could not look up that code. Check your connection.')
  }
  const payload = (await res.json().catch(() => ({}))) as { item?: { name?: string }; error?: string }
  if (!res.ok || !payload.item) throw new Error(payload.error || `No item found for code ${code}.`)
  return { name: payload.item.name || 'Item' }
}

/** The Sales page URL that adds this item to the cart when it opens. */
export const saleUrlFor = (code: string) => `/sales?${SCAN_PARAM}=${encodeURIComponent(code)}`
