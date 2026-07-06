// Web search tool -- uses Serper.dev (free tier: 2,500 searches/month)
// Searches for trending items in the Philippines and cross-references with store inventory

import { getAdminDb } from '@/lib/firebaseAdmin'
import { aiCache } from '@/lib/ai/cache'

const db = () => getAdminDb()
const toNum = (v: unknown, fb = 0): number => {
  if (typeof v === 'number' && isFinite(v)) return v
  if (typeof v === 'string') { const p = Number(v); if (isFinite(p)) return p }
  return fb
}
const fmt = (n: number) => `₱${n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

interface SerperResult {
  organic?: Array<{
    title: string
    snippet: string
    link: string
  }>
  answerBox?: { answer?: string; snippet?: string }
  knowledgeGraph?: { description?: string }
}

export async function searchWebTrends(query: string): Promise<string> {
  if (!query || query.trim().length < 2) {
    return 'Please provide a search topic, e.g. "trending school items" or "popular gadgets Philippines".'
  }

  const apiKey = process.env.SERPER_API_KEY
  if (!apiKey) {
    return 'Web search is not configured. Add SERPER_API_KEY to environment variables.'
  }

  const now = new Date()
  const month = now.toLocaleDateString('en-PH', { month: 'long' })
  const year = now.getFullYear()
  const fullQuery = `${query} Philippines ${month} ${year} trending popular`

  const cacheKey = `web_trends_${query.toLowerCase().replace(/\s+/g, '_')}_${now.getMonth()}_${year}`
  const cached = aiCache.get<string>(cacheKey)
  if (cached) return cached

  try {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        q: fullQuery,
        gl: 'ph',
        hl: 'en',
        num: 8,
        tbs: 'qdr:m6',  // only results from the past 6 months
      }),
    })

    if (!res.ok) {
      return `Web search temporarily unavailable (${res.status}). Using store data only.`
    }

    const data = (await res.json()) as SerperResult
    const results = data.organic ?? []

    if (results.length === 0) {
      return `No web results found for "${query}". Using store seasonal data instead.`
    }

    const snippets = results
      .slice(0, 4)
      .map(r => `- ${r.title}: ${r.snippet.slice(0, 80)}`)
      .join('\n')

    // Cross-reference with actual store inventory
    const invSnap = await db().collection('inventory').get()
    const storeItems = invSnap.docs
      .map(d => ({ id: d.id, ...d.data() } as Record<string, unknown>))
      .filter(d => !d.isDeleted && toNum(d.stock) > 0)

    const webText = (snippets + ' ' + query).toLowerCase()
    const commonKeywords = [
      'electronic', 'appliance', 'clothing', 'bag', 'shoe', 'footwear',
      'school', 'notebook', 'fan', 'speaker', 'phone', 'gadget', 'kitchen',
      'blender', 'iron', 'rice cooker', 'shirt', 'jacket', 'watch', 'accessories',
    ]

    const matchedKeywords = commonKeywords.filter(k => webText.includes(k))

    const matchedItems = storeItems
      .filter(item => {
        const name = String(item.name ?? '').toLowerCase()
        const cat = String(item.categoryName ?? '').toLowerCase()
        return matchedKeywords.some(k => name.includes(k) || cat.includes(k))
      })
      .sort((a, b) => toNum(b.stock) - toNum(a.stock))
      .slice(0, 6)
      .map(d => `- ${d.name} (${d.categoryName ?? 'Unknown'}): ${toNum(d.stock)} units @ ${fmt(toNum(d.price))}`)

    const lines = [
      `IMPORTANT: Today's actual date is ${now.toLocaleDateString('en-PH', { month: 'long', day: 'numeric', year: 'numeric' })}. Use this date, NOT any dates mentioned in the search results below.`,
      `Web trend search: "${query}" (Philippines, ${month} ${year})`,
      '',
      `What is trending online (recent results):`,
      snippets,
      '',
      matchedItems.length > 0
        ? `Matching items in your store inventory:\n${matchedItems.join('\n')}`
        : 'No direct inventory matches found -- consider sourcing items related to these trends.',
    ]

    const result = lines.join('\n')
    aiCache.set(cacheKey, result)
    return result

  } catch (err) {
    console.error('[searchWebTrends] error:', err)
    return 'Web search failed. Using store data and seasonal knowledge for recommendations instead.'
  }
}
