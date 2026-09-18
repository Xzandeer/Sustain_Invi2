// Shared bounds for quantity fields.
//
// A stock figure is a count of physical second-hand items on a shelf in one
// small shop. Three digits is already generous; the cap exists so a slipped
// key or a held-down zero cannot write a nonsense figure into inventory and
// through to the dashboard totals, the forecast and every shipment's return.
//
// Enforced in the forms and again in the API, because a form can be bypassed.
export const MAX_STOCK = 999
export const MAX_PRICE = 999999
