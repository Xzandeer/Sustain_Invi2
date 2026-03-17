'use client'

import { Pencil, Trash2 } from 'lucide-react'

export interface Product {
  id: string
  categoryId: string
  name: string
  category: string
  price: number
  quantity: number
  minStock: number
  condition: 'New' | 'Refurbished'
  stockStatus: 'Available' | 'Low Stock' | 'Out of Stock'
  isDeleted?: boolean
}

interface ProductTableProps {
  products: Product[]
  canManage: boolean
  onEdit: (product: Product) => void
  onDelete: (productId: string) => Promise<void> | void
  deletingProductId?: string | null
  loading?: boolean
}

const stockStatusClass = (status: Product['stockStatus']) => {
  if (status === 'Out of Stock') return 'bg-rose-100 text-rose-700'
  if (status === 'Low Stock') return 'bg-amber-100 text-amber-700'
  return 'bg-emerald-100 text-emerald-700'
}

const conditionClass = (condition: Product['condition']) => {
  if (condition === 'Refurbished') return 'bg-slate-200 text-slate-700'
  return 'bg-sky-100 text-sky-800'
}

const formatPrice = (price: number) =>
  price.toLocaleString('en-PH', {
    style: 'currency',
    currency: 'PHP',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })

export default function ProductTable({
  products,
  canManage,
  onEdit,
  onDelete,
  deletingProductId,
  loading = false,
}: ProductTableProps) {
  if (loading) {
    return <p className="text-sm text-slate-500">Loading products...</p>
  }

  if (products.length === 0) {
    return <p className="text-sm text-slate-500">No products found.</p>
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200">
      <table className="min-w-full divide-y divide-slate-200">
        <thead className="bg-slate-50">
          <tr>
            <th className="px-4 py-3 text-left text-sm font-semibold text-slate-700">Item Name</th>
            <th className="px-4 py-3 text-left text-sm font-semibold text-slate-700">Category</th>
            <th className="px-4 py-3 text-left text-sm font-semibold text-slate-700">Price</th>
            <th className="px-4 py-3 text-left text-sm font-semibold text-slate-700">Quantity</th>
            <th className="px-4 py-3 text-left text-sm font-semibold text-slate-700">Condition</th>
            <th className="px-4 py-3 text-left text-sm font-semibold text-slate-700">Stock Status</th>
            {canManage && <th className="px-4 py-3 text-left text-sm font-semibold text-slate-700">Actions</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200 bg-white">
          {products.map((product) => (
            <tr key={product.id} className="hover:bg-slate-50">
              <td className="px-4 py-3 text-sm font-medium text-slate-900">{product.name}</td>
              <td className="px-4 py-3 text-sm text-slate-700">{product.category}</td>
              <td className="px-4 py-3 text-sm text-slate-900">{formatPrice(product.price)}</td>
              <td className="px-4 py-3 text-sm font-semibold text-slate-900">
                {product.quantity}
                <span className="ml-2 text-xs font-normal text-slate-500">Min: {product.minStock}</span>
              </td>
              <td className="px-4 py-3 text-sm">
                <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${conditionClass(product.condition)}`}>
                  {product.condition}
                </span>
              </td>
              <td className="px-4 py-3 text-sm">
                <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${stockStatusClass(product.stockStatus)}`}>
                  {product.stockStatus}
                </span>
              </td>
              {canManage && (
                <td className="px-4 py-3 text-sm">
                  <div className="flex items-center gap-3">
                    <button onClick={() => onEdit(product)} title="Edit" className="text-sky-800 transition hover:text-sky-600">
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => onDelete(product.id)}
                      title="Delete"
                      disabled={deletingProductId === product.id}
                      className="text-red-600 transition hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
