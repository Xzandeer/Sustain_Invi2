'use client'

import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Legend,
} from 'chart.js'
import { Line } from 'react-chartjs-2'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend)

const labels = ['Jan 1', 'Jan 2', 'Jan 3', 'Jan 4', 'Jan 5', 'Jan 6', 'Jan 7', 'Jan 8']
const values = [2000, 2500, 2200, 3100, 2800, 3500, 4100, 3900]

export default function SalesTrendChart() {
  return (
    <section className="bg-white rounded-xl shadow-sm p-6 border space-y-2">
      <h2 className="text-xl font-semibold text-slate-900">Sales Trend</h2>
      <p className="text-sm text-slate-500">All categories combined</p>
      <div className="h-[360px]">
        <Line
          data={{
            labels,
            datasets: [
              {
                label: 'Sales',
                data: values,
                borderColor: '#0f4c81',
                backgroundColor: 'rgba(15, 76, 129, 0.12)',
                borderWidth: 2,
                pointRadius: 3,
                tension: 0.3,
                fill: true,
              },
            ],
          }}
          options={{
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { display: false },
            },
            scales: {
              x: { grid: { display: false } },
              y: {
                beginAtZero: true,
                ticks: {
                  callback: (value) => `\u20b1${Number(value).toLocaleString()}`,
                },
              },
            },
          }}
        />
      </div>
    </section>
  )
}
