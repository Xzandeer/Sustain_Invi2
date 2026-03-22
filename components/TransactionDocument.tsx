'use client'

import { forwardRef } from 'react'
import {
  CompletedTransactionDocument,
  formatCurrency,
  formatTransactionDateTime,
} from '@/lib/transactionDocuments'

interface TransactionDocumentProps {
  document: CompletedTransactionDocument
}

const labelClassName = 'text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400'
const valueClassName = 'mt-1 text-[13px] text-slate-700'

const TransactionDocument = forwardRef<HTMLDivElement, TransactionDocumentProps>(function TransactionDocument(
  { document },
  ref
) {
  const isSale = document.type === 'sale'

  return (
    <div
      ref={ref}
      className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6 print:border-0 print:shadow-none"
    >
      <div className="flex flex-wrap items-start justify-between gap-5 border-b border-dashed border-slate-200 pb-5">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-sky-700/90">
            {isSale ? 'Sales Receipt' : 'Reservation Ticket'}
          </p>
          <h2 className="mt-2.5 text-[1.7rem] font-bold tracking-tight text-slate-900 sm:text-[1.55rem]">
            {document.storeName}
          </h2>
          {!isSale ? <p className="mt-1 text-xs text-slate-400">{document.storeTagline}</p> : null}
        </div>
        <div className="min-w-[210px] text-left sm:text-right">
          <p className={labelClassName}>{isSale ? 'Receipt No.' : 'Reservation Code'}</p>
          <p className="mt-1.5 text-base font-bold tracking-tight text-slate-900 sm:text-lg">
            {isSale ? document.receiptNumber : document.reservationCode}
          </p>
          <p className="mt-1.5 text-[11px] text-slate-400">
            {formatTransactionDateTime(isSale ? document.transactionDate : document.reservationDate)}
          </p>
        </div>
      </div>

      <div className="mt-5 grid gap-5 sm:grid-cols-2">
        <div className="space-y-1">
          <p className={labelClassName}>Customer</p>
          <p className="pt-1 font-semibold text-slate-900">{document.customer.fullName}</p>
          <p className={valueClassName}>{document.customer.email || 'No email provided'}</p>
          <p className={valueClassName}>{document.customer.contactNumber}</p>
        </div>
        <div className="space-y-1">
          <p className={labelClassName}>Processed By</p>
          <p className="pt-1 font-semibold text-slate-900">{document.processedBy}</p>
          <p className={valueClassName}>
            {isSale ? 'Completed transaction receipt' : 'Reservation claim stub'}
          </p>
        </div>
      </div>

      <div className="mt-5 overflow-hidden rounded-xl border border-slate-200">
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
            <tr>
              <th className="px-3.5 py-2.5 text-left text-[13px] font-semibold text-slate-700">
                {isSale ? 'Purchased Items' : 'Reserved Items'}
              </th>
              <th className="px-3.5 py-2.5 text-left text-[13px] font-semibold text-slate-700">Qty</th>
              {isSale ? (
                <>
                  <th className="px-3.5 py-2.5 text-left text-[13px] font-semibold text-slate-700">Unit Price</th>
                  <th className="px-3.5 py-2.5 text-left text-[13px] font-semibold text-slate-700">Subtotal</th>
                </>
              ) : null}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 bg-white">
            {document.items.map((item) => (
              <tr key={`${item.itemId}-${item.condition}`}>
                <td className="px-3.5 py-2.5 text-[13px] text-slate-700">
                  <p className="font-medium text-slate-900">{item.name}</p>
                  <p className="text-[11px] text-slate-500">{item.condition}</p>
                </td>
                <td className="px-3.5 py-2.5 text-[13px] text-slate-700">{item.quantity}</td>
                {isSale ? (
                  <>
                    <td className="px-3.5 py-2.5 text-[13px] text-slate-700">{formatCurrency(item.price)}</td>
                    <td className="px-3.5 py-2.5 text-[13px] font-semibold text-slate-900">{formatCurrency(item.subtotal)}</td>
                  </>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {isSale ? (
        <div className="mt-5 flex flex-col gap-3.5 border-t border-slate-200 pt-4 sm:flex-row sm:items-end sm:justify-between">
          <p className="max-w-[16rem] text-[13px] text-slate-400">{document.note}</p>
          <div className="text-left sm:text-right">
            <p className={labelClassName}>Total Amount</p>
            <p className="mt-1.5 text-[1.8rem] font-bold tracking-tight text-slate-900 sm:text-[1.7rem]">
              {formatCurrency(document.totalAmount)}
            </p>
          </div>
        </div>
      ) : (
        <div className="mt-5 space-y-3 rounded-xl bg-slate-50 px-3.5 py-3.5">
          <div>
            <p className={labelClassName}>Claim Instructions</p>
            <p className={valueClassName}>{document.claimInstructions}</p>
          </div>
          <div>
            <p className={labelClassName}>Notice</p>
            <p className={valueClassName}>{document.notice}</p>
          </div>
        </div>
      )}
    </div>
  )
})

export default TransactionDocument
