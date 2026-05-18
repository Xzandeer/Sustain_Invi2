'use client'

interface LowStockRow {
  category: string
  stock: number
  threshold: number
  status: 'Low' | 'OK'
}

interface LowStockCategoriesProps {
  rows: LowStockRow[]
}

export default function LowStockCategories({ rows }: LowStockCategoriesProps) {
  return (
    <section className="bg-white rounded-xl shadow-sm p-6 border">
      <h2 className="mb-4 text-xl font-semibold text-slate-900">Low Stock Categories</h2>
      <div className="overflow-x-auto rounded-lg border">
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
            <tr>
              <th className="px-4 py-3 text-left text-sm font-semibold text-slate-700">Category</th>
              <th className="px-4 py-3 text-left text-sm font-semibold text-slate-700">Total Current Stock</th>
              <th className="px-4 py-3 text-left text-sm font-semibold text-slate-700">Threshold</th>
              <th className="px-4 py-3 text-left text-sm font-semibold text-slate-700">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 bg-white">
            {rows.map((row) => (
              <tr key={row.category} className="hover:bg-gray-50">
                <td className="px-4 py-3 text-sm text-slate-900">{row.category}</td>
                <td className="px-4 py-3 text-sm text-slate-700">{row.stock}</td>
                <td className="px-4 py-3 text-sm text-slate-700">{row.threshold}</td>
                <td className="px-4 py-3 text-sm">
                  <span
                    className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${
                      row.status === 'Low'
                        ? 'bg-red-100 text-red-600'
                        : 'bg-green-100 text-green-700'
                    }`}
                  >
                    {row.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
