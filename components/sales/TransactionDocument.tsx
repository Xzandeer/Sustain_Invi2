'use client'

// Printable / emailable receipt and reservation ticket layout.
// Also captured as an image for the email attachment.

import { forwardRef } from 'react'
import {
  CompletedTransactionDocument,
  formatCurrency,
  formatTransactionDateTime,
} from '@/lib/transactions/transactionDocuments'

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
      {/* Whole header right-aligned. In a panel this narrow the two halves
          always wrap onto separate lines, and mixing a left-aligned store
          block with a right-aligned number block left a ragged edge down the
          middle with nothing lining up on either side. */}
      <div className="flex flex-wrap items-start justify-between gap-x-5 gap-y-3 border-b border-dashed border-slate-200 pb-4 text-right">
        <div className="ml-auto">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-sky-700/90">
            {isSale ? 'Sales Invoice' : 'Reservation Ticket'}
          </p>
          <h2 className="mt-1.5 text-[1.45rem] font-bold leading-tight tracking-tight text-slate-900">
            {document.storeName}
          </h2>
          {!isSale ? <p className="mt-1 text-xs text-slate-400">{document.storeTagline}</p> : null}
          {/* Seller details required on an invoice under RR 7-2024. Rendered
              only when the shop has entered them, so a blank Settings field
              leaves the invoice clean rather than showing empty labels. */}
          {isSale && document.sellerRegisteredName ? (
            <p className="mt-1.5 text-[12px] font-medium text-slate-600">
              {document.sellerRegisteredName}
            </p>
          ) : null}
          {isSale && document.sellerAddress ? (
            <p className="ml-auto mt-0.5 max-w-[18rem] text-[11px] leading-snug text-slate-500">
              {document.sellerAddress}
            </p>
          ) : null}
          {isSale && document.sellerTin ? (
            <p className="mt-0.5 text-[11px] text-slate-500">TIN: {document.sellerTin}</p>
          ) : null}
        </div>
        {/* ml-auto, not just text-right. The header is a wrapping flex row, so
            in a narrow panel this block drops onto its own line and justify-
            between no longer pushes it anywhere - it sat at the left edge with
            its text right-aligned inside, which read as neither. */}
        <div className="ml-auto text-right">
          <p className={labelClassName}>{isSale ? 'Invoice No.' : 'Reservation Code'}</p>
          <p className="mt-1 whitespace-nowrap text-base font-bold tracking-tight text-slate-900">
            {isSale ? document.receiptNumber : document.reservationCode}
          </p>
          <p className="mt-0.5 text-[11px] text-slate-400">
            {formatTransactionDateTime(isSale ? document.transactionDate : document.reservationDate)}
          </p>
        </div>
      </div>

      {/* Customer details appear on reservation tickets only.
          A sales invoice carries no customer name and no staff name: a walk-in
          buyer gives no details, and printing who served them puts a staff
          member's name in a stranger's pocket for no operational benefit. Both
          are still recorded against the transaction for the audit trail. */}
      {/* Stacked, not a two-column grid. In the preview panel the two columns
          are about 130px each, so a long email address ran straight into the
          "Processed By" value beside it. Stacking also drops the filler line
          "Reservation claim stub", which labelled nothing. */}
      {!isSale && (
        <div className="mt-4 space-y-3">
          <div>
            <p className={labelClassName}>Customer</p>
            <p className="pt-1 font-semibold text-slate-900">{document.customer.fullName}</p>
            {document.customer.contactNumber ? (
              <p className={valueClassName}>{document.customer.contactNumber}</p>
            ) : null}
            {document.customer.email ? (
              <p className={valueClassName + ' break-all'}>{document.customer.email}</p>
            ) : null}
          </div>
          <div>
            <p className={labelClassName}>Processed By</p>
            <p className="pt-1 font-semibold text-slate-900">{document.processedBy}</p>
          </div>
        </div>
      )}

      <div className="mt-4 overflow-hidden rounded-xl border border-slate-200">
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
            {/* Short headers, numbers right-aligned and never wrapped. The
                panel is narrow, and "Purchased Items" / "Unit Price" each broke
                onto two lines, making the header taller than the rows under
                it. Money reads better aligned on the decimal point anyway. */}
            <tr>
              <th className="px-3 py-2 text-left text-[13px] font-semibold text-slate-700">
                {isSale ? 'Item' : 'Reserved Item'}
              </th>
              <th className="whitespace-nowrap px-3 py-2 text-right text-[13px] font-semibold text-slate-700">Qty</th>
              {isSale ? (
                <>
                  <th className="whitespace-nowrap px-3 py-2 text-right text-[13px] font-semibold text-slate-700">Price</th>
                  <th className="whitespace-nowrap px-3 py-2 text-right text-[13px] font-semibold text-slate-700">Total</th>
                </>
              ) : null}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 bg-white">
            {document.items.map((item) => (
              <tr key={`${item.itemId}-${item.condition}`}>
                <td className="px-3 py-2 text-[13px] text-slate-700">
                  <p className="font-medium leading-snug text-slate-900">{item.name}</p>
                  <p className="text-[11px] text-slate-500">{item.condition}</p>
                  {item.conditionNotes ? (
                    <p className="text-[11px] italic text-slate-500">{item.conditionNotes}</p>
                  ) : null}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right text-[13px] text-slate-700">{item.quantity}</td>
                {isSale ? (
                  <>
                    <td className="whitespace-nowrap px-3 py-2 text-right text-[13px] tabular-nums text-slate-700">{formatCurrency(item.price)}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right text-[13px] font-semibold tabular-nums text-slate-900">{formatCurrency(item.subtotal)}</td>
                  </>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Total on its own line, note beneath. Side by side the label sat above
          the amount while the thank-you sat below it, so the two baselines
          never lined up and the block read as misaligned rather than a total. */}
      {isSale ? (
        <div className="mt-4 border-t border-slate-200 pt-3">
          <div className="flex items-baseline justify-between gap-4">
            <p className={labelClassName}>Total Amount</p>
            <p className="text-2xl font-bold tracking-tight tabular-nums text-slate-900">
              {formatCurrency(document.totalAmount)}
            </p>
          </div>
          <p className="mt-2 text-[12px] text-slate-400">{document.note}</p>
        </div>
      ) : (
        <div className="mt-4 rounded-xl bg-slate-50 px-3.5 py-3">
          {/* One block. These were two labelled sections that both said
              "present this ticket", which read as a warning rather than an
              instruction. */}
          <p className={labelClassName}>Claiming</p>
          <p className={valueClassName + ' mt-1'}>{document.claimInstructions}</p>
          <p className="mt-1 text-[11px] text-slate-400">{document.notice}</p>
        </div>
      )}
    </div>
  )
})

export default TransactionDocument
