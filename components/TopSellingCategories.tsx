'use client'

interface TopSellingRow {
  categoryId: string
  categoryName: string
  totalSales: number
  totalRevenue: number
  todaysSales: number
}

interface TopSellingCategoriesProps {
  rows: TopSellingRow[]
}

const currency = (value: number) => `\u20b1${value.toLocaleString('en-US')}`

export default function TopSellingCategories({ rows }: TopSellingCategoriesProps) {
  return (
    <section className="bg-white rounded-xl shadow-sm p-6 border">
      <h2 className="mb-4 text-xl font-semibold text-slate-900">Top-Selling Categories</h2>
      <div className="overflow-x-auto rounded-lg border">
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
            <tr>
              <th className="px-4 py-3 text-left text-sm font-semibold text-slate-700">Category</th>
              <th className="px-4 py-3 text-left text-sm font-semibold text-slate-700">Total Sales (Units)</th>
              <th className="px-4 py-3 text-left text-sm font-semibold text-slate-700">Total Revenue</th>
              <th className="px-4 py-3 text-left text-sm font-semibold text-slate-700">Today's Sales</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 bg-white">
            {rows.map((row) => (
              <tr key={row.categoryId} className="hover:bg-gray-50">
                <td className="px-4 py-3 text-sm text-slate-900">{row.categoryName}</td>
                <td className="px-4 py-3 text-sm text-slate-700">{row.totalSales}</td>
                <td className="px-4 py-3 text-sm text-slate-700">{currency(row.totalRevenue)}</td>
                <td className="px-4 py-3 text-sm text-slate-700">{currency(row.todaysSales)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
