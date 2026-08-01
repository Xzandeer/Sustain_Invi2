// Print-formatted receipt/ticket - generates HTML for thermal printer output.
//
// Supports the two common thermal roll widths, 58mm and 80mm. The width is a
// property of the printer physically attached to a given computer, not of the
// shop, so the choice is stored per browser in localStorage rather than in the
// shared store settings - two terminals may well have different printers.
import { CompletedTransactionDocument, formatCurrency, formatTransactionDateTime } from '@/lib/transactions/transactionDocuments'

export type ReceiptPaperWidth = 58 | 80

export const RECEIPT_WIDTH_STORAGE_KEY = 'sustain.receipt.paperWidth'

// Roll width vs. printable width: thermal heads leave an unprinted margin at
// each edge, so the usable area is a few millimetres narrower than the paper.
const PAPER = {
  58: { roll: '58mm', content: '54mm', body: 11, small: 9,  store: 13, total: 12, pad: '2mm' },
  80: { roll: '80mm', content: '76mm', body: 13, small: 11, store: 16, total: 14, pad: '4mm' },
} as const

export const getReceiptPaperWidth = (): ReceiptPaperWidth => {
  if (typeof window === 'undefined') return 80
  return window.localStorage.getItem(RECEIPT_WIDTH_STORAGE_KEY) === '58' ? 58 : 80
}

export const setReceiptPaperWidth = (width: ReceiptPaperWidth) => {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(RECEIPT_WIDTH_STORAGE_KEY, String(width))
}

// Open receipt in new window with print dialog auto-opened
export const openReceiptPrintWindow = (
  document: CompletedTransactionDocument,
  paperWidth: ReceiptPaperWidth = getReceiptPaperWidth()
) => {
  if (!document) return

  const paper = PAPER[paperWidth]
  const isSale = document.type === 'sale'

  // Step 1: Build HTML document formatted for 80mm thermal receipts
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${isSale ? 'Sales Receipt' : 'Reservation Ticket'}</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    html, body {
      width: 100%;
      height: 100%;
      background: white;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', sans-serif;
      line-height: 1.4;
      color: #1e293b;
      padding: 0;
      margin: 0;
    }

    .receipt-container {
      width: ${paper.roll};
      margin: 0 auto;
      padding: 20px 0;
      background: white;
    }

    .receipt-content {
      width: 100%;
      background: white;
      padding: 16px;
      font-size: 12px;
    }

    .receipt-header {
      border-bottom: 1px dashed #cbd5e1;
      padding-bottom: 12px;
      margin-bottom: 12px;
      text-align: center;
    }

    .store-name {
      font-size: 14px;
      font-weight: bold;
      margin-bottom: 4px;
    }

    .store-tagline {
      font-size: 10px;
      color: #64748b;
      margin-bottom: 8px;
    }

    .receipt-number {
      font-weight: bold;
      font-size: 13px;
      margin-bottom: 4px;
    }

    .receipt-date {
      font-size: 10px;
      color: #64748b;
    }

    .section {
      margin-bottom: 12px;
    }

    .section-label {
      font-size: 10px;
      font-weight: bold;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: #64748b;
      margin-bottom: 4px;
    }

    .section-content {
      font-size: 11px;
    }

    .customer-info {
      margin-bottom: 12px;
    }

    .customer-name {
      font-weight: bold;
      margin-bottom: 2px;
    }

    .customer-detail {
      font-size: 10px;
      color: #475569;
      margin-bottom: 2px;
    }

    .items-table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 12px;
    }

    .items-table thead {
      border-top: 1px dashed #cbd5e1;
      border-bottom: 1px dashed #cbd5e1;
    }

    .items-table th {
      text-align: left;
      padding: 6px 0;
      font-size: 10px;
      font-weight: bold;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #475569;
    }

    .items-table td {
      padding: 6px 0;
      font-size: 11px;
      vertical-align: top;
    }

    .item-col-name {
      width: 40%;
    }

    .item-col-qty {
      width: 15%;
      text-align: center;
    }

    .item-col-price {
      width: 22%;
      text-align: right;
    }

    .item-col-subtotal {
      width: 23%;
      text-align: right;
    }

    .item-name {
      font-weight: 600;
      margin-bottom: 2px;
    }

    .item-condition {
      font-size: 9px;
      color: #64748b;
    }

    .total-section {
      border-top: 1px dashed #cbd5e1;
      padding-top: 12px;
      margin-top: 12px;
      text-align: right;
    }

    .total-row {
      display: flex;
      justify-content: space-between;
      margin-bottom: 4px;
      font-size: 11px;
    }

    .total-amount {
      font-size: 16px;
      font-weight: bold;
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid #1e293b;
    }

    .footer {
      text-align: center;
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px dashed #cbd5e1;
      font-size: 10px;
      color: #64748b;
      line-height: 1.6;
    }

    .processed-by {
      font-size: 10px;
      margin-top: 12px;
      text-align: right;
      color: #64748b;
    }

    /* Page size for the printer.
     *
     * Without this the browser assumes a normal sheet (usually A4) and a
     * thermal printer on continuous roll paper keeps feeding until it reaches
     * what it thinks is the bottom of the page - around 297mm - leaving a long
     * blank tail after every receipt.
     *
     * 80mm is the roll width; "auto" height makes the page exactly as tall as
     * the receipt content and no taller. */
    @page {
      size: ${paper.roll} auto;
      margin: 0;
    }

    @media print {
      /* Percentage heights resolve against the full page when printing, which
       * would pad the receipt out to a whole sheet again. */
      html, body {
        height: auto;
        width: ${paper.roll};
        margin: 0;
        padding: 0;
      }
      .receipt-container {
        width: ${paper.roll};
        margin: 0;
        padding: 0;
      }
      .receipt-content {
        padding: 0 ${paper.pad};
        max-width: ${paper.content};
      }
      /* Never split a receipt across two pages of roll paper. */
      .receipt-container, .receipt-content {
        page-break-inside: avoid;
        break-inside: avoid;
      }

      /* Thermal printers are 203 dpi and strictly black or white - there is no
       * grey. Any grey text is reproduced by scattering dots, which reads as
       * faint and blurry on paper. So for printing only, everything becomes
       * pure black and slightly larger and heavier. The screen preview above
       * keeps its softer styling. */
      * {
        color: #000 !important;
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
        text-shadow: none !important;
        -webkit-font-smoothing: none;
      }

      .receipt-content {
        font-size: ${paper.body}px;
        line-height: 1.45;
        font-weight: 500;
      }

      /* Small print - labels, notes, timestamps - was 10px, which is under two
       * millimetres tall at this resolution and loses stroke detail. */
      .store-tagline,
      .receipt-footer,
      .receipt-meta,
      .item-condition,
      small {
        font-size: ${paper.small}px !important;
        font-weight: 500 !important;
      }

      .store-name { font-size: ${paper.store}px !important; font-weight: 800 !important; }
      .total-row, .total-amount { font-weight: 800 !important; font-size: ${paper.total}px !important; }

      /* Long item names must wrap rather than push the price column off the
       * paper - much more likely at 58mm than 80mm. */
      table { width: 100%; table-layout: fixed; }
      td, th { overflow-wrap: anywhere; word-break: break-word; }

      /* Solid black rules print cleanly; light dashed ones break up into
       * intermittent dots. */
      .receipt-header,
      .receipt-divider,
      .totals-section,
      table, th, td {
        border-color: #000 !important;
      }
      .receipt-header {
        border-bottom-style: solid !important;
        border-bottom-width: 1px !important;
      }

      /* Backgrounds waste ink-free paper coating and muddy the text on top. */
      * { background: transparent !important; }
    }
  </style>
</head>
<body>
  <div class="receipt-container">
    <div class="receipt-content">
      <div class="receipt-header">
        <div class="store-name">${document.storeName}</div>
        ${!isSale ? `<div class="store-tagline">${document.storeTagline}</div>` : ''}
        <div class="receipt-number">${isSale ? document.receiptNumber : document.reservationCode}</div>
        <div class="receipt-date">${formatTransactionDateTime(isSale ? document.transactionDate : document.reservationDate)}</div>
      </div>

      <div class="section customer-info">
        <div class="section-label">Customer</div>
        <div class="customer-name">${document.customer.fullName}</div>
        <div class="customer-detail">${document.customer.email || 'No email'}</div>
        <div class="customer-detail">${document.customer.contactNumber}</div>
      </div>

      <div class="section">
        <div class="section-label">Processed By</div>
        <div class="section-content">${document.processedBy}</div>
      </div>

      <table class="items-table">
        <thead>
          <tr>
            <th class="item-col-name">${isSale ? 'Item' : 'Item'}</th>
            <th class="item-col-qty">Qty</th>
            ${isSale ? '<th class="item-col-price">Price</th>' : ''}
            ${isSale ? '<th class="item-col-subtotal">Total</th>' : ''}
          </tr>
        </thead>
        <tbody>
          ${document.items
            .map(
              (item) => `
            <tr>
              <td class="item-col-name">
                <div class="item-name">${item.name}</div>
                <div class="item-condition">${item.condition}</div>
              </td>
              <td class="item-col-qty">${item.quantity}</td>
              ${isSale ? `<td class="item-col-price">${formatCurrency(item.price)}</td>` : ''}
              ${isSale ? `<td class="item-col-subtotal">${formatCurrency(item.subtotal)}</td>` : ''}
            </tr>
          `
            )
            .join('')}
        </tbody>
      </table>

      ${
        isSale
          ? `
        <div class="total-section">
          <div class="total-amount">${formatCurrency(document.totalAmount)}</div>
        </div>
      `
          : `
        <div class="section">
          <div class="section-label">Claim Instructions</div>
          <div class="section-content" style="font-size: 10px; line-height: 1.5;">
            ${document.claimInstructions}
          </div>
        </div>
        <div class="section">
          <div class="section-label">Notice</div>
          <div class="section-content" style="font-size: 10px; line-height: 1.5;">
            ${document.notice}
          </div>
        </div>
      `
      }

      <div class="footer">
        ${isSale ? document.note : ''}
      </div>

      <div class="processed-by">
        ${isSale ? 'Thank you for your purchase' : 'Keep this ticket for claiming'}
      </div>
    </div>
  </div>

  <script>
    // Print once the layout has settled, then close the tab so repeated sales
    // do not leave a pile of receipt windows open behind the app.
    window.addEventListener('load', function () {
      var printed = false;
      function runPrint() {
        if (printed) return;
        printed = true;
        window.print();
      }
      window.addEventListener('afterprint', function () {
        window.close();
      });
      setTimeout(runPrint, 250);
    });
  </script>
</body>
</html>
  `

  // Step 2: Open new window and write HTML
  const printWindow = window.open('', '_blank', 'width=400,height=600')
  if (printWindow) {
    printWindow.document.write(html)
    printWindow.document.close()
    // JavaScript inside HTML will trigger print dialog on page load
  }
}
