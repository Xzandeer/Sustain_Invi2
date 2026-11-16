// Sales for the assistant's tools - one shared, bounded read.
//
// The tools used to read the whole sales collection for every new question
// (thousands of reads each). They now share one read of the last six months,
// remembered for five minutes, which covers every answer they give: the
// six-month trend, the 90-day outlook, this month, and "top" lists over the
// last six months.

import { getAdminDb } from '@/lib/firebaseAdmin'
import { remember } from '@/lib/server/readCache'

/** Days of sales the assistant looks at (six calendar months back to the 1st). */
export const CHAT_SALES_DAYS = 186

type SaleDoc = { id: string; data: () => Record<string, unknown> }

/** The last CHAT_SALES_DAYS of sales, shaped like a query snapshot. */
export async function recentSalesSnap(): Promise<{ docs: SaleDoc[] }> {
  const since = new Date()
  since.setDate(since.getDate() - CHAT_SALES_DAYS)
  since.setHours(0, 0, 0, 0)
  const rows = await remember(`sales:chat:${since.getTime()}`, 5 * 60_000, async () => {
    const snap = await getAdminDb().collection('sales').where('createdAt', '>=', since).get()
    return snap.docs.map((d) => ({ id: d.id, data: d.data() as Record<string, unknown> }))
  })
  return { docs: rows.map((r) => ({ id: r.id, data: () => r.data })) }
}
