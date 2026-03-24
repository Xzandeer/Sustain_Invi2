import { CompletedTransactionDocument, formatCurrency, formatTransactionDateTime } from '@/lib/transactionDocuments'

export const openReceiptPrintWindow = (document: CompletedTransactionDocument) => {
  if (!document) return

  const isSale = document.type === 'sale'

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
      width: 80mm;
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

    @media print {
      body {
        margin: 0;
        padding: 0;
      }
      .receipt-container {
        width: 80mm;
        margin: 0;
        padding: 0;
      }
      .receipt-content {
        padding: 0;
      }
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
    window.addEventListener('load', function() {
      setTimeout(function() {
        window.print();
      }, 250);
    });
  </script>
</body>
</html>
  `

  const printWindow = window.open('', '_blank', 'width=400,height=600')
  if (printWindow) {
    printWindow.document.write(html)
    printWindow.document.close()
  }
}
