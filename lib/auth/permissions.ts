// Per-user permissions for staff accounts.
//
// Admins implicitly have every permission. Staff accounts start with a
// conservative default set and are adjusted by the administrator in
// User Management.

export type Permission =
  | 'canViewStockLogs'
  | 'canProcessRefunds'
  | 'canVoidItems'
  | 'canManageInventory'
  | 'canViewAnalytics'
  | 'canManageReservations'

export interface PermissionMeta {
  key: Permission
  label: string
  description: string
}

export const PERMISSIONS: PermissionMeta[] = [
  {
    key: 'canManageInventory',
    label: 'Manage Inventory',
    description: 'Add, edit and adjust stock for inventory items',
  },
  {
    key: 'canProcessRefunds',
    label: 'Process Refunds',
    description: 'Refund completed sales and return items to stock',
  },
  {
    key: 'canVoidItems',
    label: 'Void Items',
    description: 'Void inventory items and remove them from active stock',
  },
  {
    key: 'canManageReservations',
    label: 'Manage Reservations',
    description: 'Create, claim, release and cancel customer reservations',
  },
  {
    key: 'canViewStockLogs',
    label: 'View Stock Logs',
    description: 'Access the full inventory audit trail',
  },
  {
    key: 'canViewAnalytics',
    label: 'View Analytics',
    description: 'Access sales analytics and demand forecasting',
  },
]

export type PermissionSet = Record<Permission, boolean>

// Default permissions granted to a newly created staff account.
export const DEFAULT_STAFF_PERMISSIONS: PermissionSet = {
  canManageInventory: false,
  canProcessRefunds: false,
  canVoidItems: false,
  canManageReservations: true,
  canViewStockLogs: false,
  canViewAnalytics: false,
}

export const ALL_PERMISSIONS_GRANTED: PermissionSet = {
  canManageInventory: true,
  canProcessRefunds: true,
  canVoidItems: true,
  canManageReservations: true,
  canViewStockLogs: true,
  canViewAnalytics: true,
}

/** Reads a permission set off a Firestore user document. Admins get everything. */
export function resolvePermissions(
  data: Record<string, unknown> | undefined,
  role: 'admin' | 'staff'
): PermissionSet {
  if (role === 'admin') return { ...ALL_PERMISSIONS_GRANTED }
  const out = { ...DEFAULT_STAFF_PERMISSIONS }
  if (!data) return out
  for (const { key } of PERMISSIONS) {
    if (typeof data[key] === 'boolean') out[key] = data[key] as boolean
  }
  return out
}
