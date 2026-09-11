// Whether the AI assistant is switched on.
//
// One switch, read by both the floating button in the dashboard layout and the
// /api/chat route behind it. Hiding the button alone would leave the endpoint
// reachable by anyone who knew the URL, and every call to it spends credit on
// the OpenAI account.
//
// WHY IT IS OFF
// The assistant answered reliably for figures it could look up, but the way it
// phrased those answers was not dependable enough to put in front of a user who
// would take them at face value. Recorded as a limitation rather than removed,
// because the tool layer underneath it - twenty-five read-only queries, with
// eleven withheld from staff accounts - is sound and worth keeping.
//
// Demand forecasting does NOT go through here. It is a separate statistical
// calculation in lib/ai/forecast, and it is unaffected by this switch.
export const AI_ASSISTANT_ENABLED = false
