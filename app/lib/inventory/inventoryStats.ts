// app/lib/inventory/inventoryStats.ts

export async function getInventoryStats() {
  // Mocked analytics data
  return {
    totalItems: 120,
    lowStock: 8,
    outOfStock: 3,
    totalCategories: 5
  };
}
