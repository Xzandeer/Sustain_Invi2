// Imported daily sales history (see scripts/import-sales-history.js).
//
// The store's notebook records one total per day and nothing about which items
// were sold, so it is kept in its own collection rather than turned into sale
// transactions. Where a date has an imported total, that total is used in place
// of recorded sales for the sales trend and the forecast. Item and category
// figures always come from recorded transactions only.

import { getAdminDb } from '@/lib/firebaseAdmin'

export const SALES_HISTORY_COLLECTION = 'salesHistory'

/**
 * Imported totals keyed by YYYY-MM-DD, for dates within [fromKey, toKey].
 * Callers pass toKey <= today: history replayed onto later dates stays hidden
 * until its day arrives.
 */
export async function getSalesHistoryTotals(fromKey: string, toKey: string): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  try {
    const snap = await getAdminDb()
      .collection(SALES_HISTORY_COLLECTION)
      .where('dateKey', '>=', fromKey)
      .where('dateKey', '<=', toKey)
      .get()
    snap.docs.forEach((d) => {
      const data = d.data() as { dateKey?: unknown; total?: unknown }
      const total = Number(data.total)
      if (typeof data.dateKey === 'string' && Number.isFinite(total) && total > 0) {
        out.set(data.dateKey, total)
      }
    })
  } catch (error) {
    // History is optional. A failure here must not stop the forecast.
    console.warn('[salesHistory] Could not read imported history:', error)
  }
  return out
}
