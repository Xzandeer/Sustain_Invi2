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

export type CancellationReasonType = 'manual' | 'system'

export const SYSTEM_CANCELLATION_REASON = 'Reservation expired'

export const isCancellationReasonValid = (reason: string | unknown): reason is CancellationReasonOption =>
  typeof reason === 'string' && CANCELLATION_REASONS.includes(reason as CancellationReasonOption)

export const getCancellationReasonTypeLabel = (type: CancellationReasonType): string => {
  return type === 'manual' ? 'Manually Cancelled' : 'Automatically Expired'
}
