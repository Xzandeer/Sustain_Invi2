// Decides what kind of event the owner entered and which product categories it
// affects.
//
// The owner writes events in their own words - "Container of big items only",
// "Back-to-school stock". The language model reads the event together with the
// store's actual categories (with example items and price ranges taken from the
// inventory) and names the categories it concerns, with a short reason. The
// answer is saved with the event, so every forecast uses the same decision, and
// the owner can override it by choosing a category by hand.

export interface CategoryProfile {
  name: string
  priceMin: number
  priceMax: number
  examples: string[]
}

export type ClassifiedType = 'shipment' | 'sale' | 'closure' | 'other'

export interface EventClassification {
  type: ClassifiedType
  wholeStore: boolean
  categories: string[] // subset of the store's category names
  reason: string
}

const TIMEOUT_MS = 10_000

export async function classifyEvent(
  note: string,
  catalogue: CategoryProfile[],
  apiKey: string
): Promise<EventClassification> {
  const names = catalogue.map(c => c.name)
  const prompt = `A Philippine Japan-surplus store recorded an upcoming event.
EVENT: "${note}"

The store's categories, with price ranges and example items currently in inventory:
${catalogue.map(c => `- ${c.name}: PHP ${c.priceMin}-${c.priceMax}; e.g. ${c.examples.join(', ') || 'no items'}`).join('\n')}

1. What type of event is it?
   "shipment" = new stock, a container or delivery arriving
   "sale" = discount, promotion, clearance
   "closure" = store closed, short hours, typhoon, bad weather, power outage
   "other" = anything else
2. Which categories will this event affect? Judge from the meaning, not just matching words:
"big items" means large, high-priced pieces; "small items" means cheap, small pieces; a
closure, typhoon or store-wide sale affects the whole store. If the event does not point to
particular categories, it affects the whole store.

Return ONLY JSON: {"type": "shipment|sale|closure|other", "wholeStore": true|false, "categories": ["exact category names"], "reason": "max 15 words"}`

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You classify retail events. Output only valid JSON.' },
        { role: 'user', content: prompt },
      ],
      max_tokens: 150,
      temperature: 0,
    }),
  })
  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } }
  if (!res.ok) throw new Error(data?.error?.message ?? `OpenAI error ${res.status}`)

  const raw = (data.choices?.[0]?.message?.content ?? '{}').replace(/```(?:json)?/g, '').trim()
  const parsed = JSON.parse(raw) as { type?: unknown; wholeStore?: unknown; categories?: unknown; reason?: unknown }
  const type: ClassifiedType = ['shipment', 'sale', 'closure', 'other'].includes(String(parsed.type))
    ? (parsed.type as ClassifiedType)
    : 'other'

  // Keep only real category names, matched case-insensitively.
  const picked = Array.isArray(parsed.categories)
    ? parsed.categories
        .map(c => names.find(n => n.toLowerCase() === String(c).trim().toLowerCase()))
        .filter((n): n is string => !!n)
    : []
  const wholeStore = parsed.wholeStore === true || picked.length === 0 || picked.length === names.length
  return {
    type,
    wholeStore,
    categories: wholeStore ? [] : Array.from(new Set(picked)),
    reason: typeof parsed.reason === 'string' ? parsed.reason.trim().slice(0, 140) : '',
  }
}
