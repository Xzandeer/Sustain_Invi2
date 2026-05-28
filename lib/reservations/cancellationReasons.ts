// Reservation cancellation reasons and types
// List of predefined cancellation reasons available to users
export const CANCELLATION_REASONS = [
  'Customer changed mind',
  'Customer did not pick up on time',
  'Duplicate reservation',
  'Wrong item reserved',
  'Customer requested cancellation',
  'Payment issue',
  'Stock issue',
  'Other',
] as const

export type CancellationReasonOption = (typeof CANCELLATION_REASONS)[number]

// Type of cancellation: manual (user-initiated) or system (auto-expired)
export type CancellationReasonType = 'manual' | 'system'

// Default reason when system automatically expires a reservation
export const SYSTEM_CANCELLATION_REASON = 'Reservation expired'

// Validate that a reason is one of the predefined options
export const isCancellationReasonValid = (reason: string | unknown): reason is CancellationReasonOption =>
  typeof reason === 'string' && CANCELLATION_REASONS.includes(reason as CancellationReasonOption)

// Get human-readable label for cancellation type
export const getCancellationReasonTypeLabel = (type: CancellationReasonType): string => {
  return type === 'manual' ? 'Manually Cancelled' : 'Automatically Expired'
}
