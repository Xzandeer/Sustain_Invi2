// Saves an inventory item through the inventory API.
//
// One request used by every screen that adds or edits an item - the Inventory
// page and the Add Item quick action on the dashboard - so validation, the
// stock log entry and barcode assignment all happen in exactly one place
// (the API route), and the client sends the same body from both screens.

import { apiFetch } from '@/lib/apiFetch'
import { auth } from '@/lib/firebase'
import type { ProductFormValues } from '@/components/inventory/ProductModal'

export interface CategoryRef {
  id: string
  name: string
}

/**
 * Creates the item, or updates it when `editingId` is given.
 * Throws an Error with a readable message on failure.
 */
export async function saveProduct(
  values: ProductFormValues,
  categories: CategoryRef[],
  editingId?: string | null
): Promise<void> {
  const category = categories.find((item) => item.id === values.categoryId)
  if (!category) {
    throw new Error('Please select a valid category.')
  }

  const response = await apiFetch(editingId ? `/api/inventory/${editingId}` : '/api/inventory', {
    method: editingId ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: values.name,
      categoryId: values.categoryId,
      categoryName: category.name,
      price: values.price,
      quantity: values.quantity,
      minStock: values.minStock,
      condition: values.condition,
      isSingleItem: values.isSingleItem === true,
      conditionNotes: values.conditionNotes ?? '',
      processedBy: {
        uid: auth.currentUser?.uid ?? '',
        email: auth.currentUser?.email ?? '',
        name: auth.currentUser?.displayName ?? auth.currentUser?.email ?? '',
      },
    }),
  })

  const payload = (await response.json().catch(() => ({}))) as { error?: string }
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to save item.')
  }
}
