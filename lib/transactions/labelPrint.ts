// Barcode label printing.
//
// Opens a standalone print window containing one label per unit, sized to the
// thermal roll width already chosen in Settings.
//
// The barcode itself is drawn by JsBarcode loaded from a CDN INSIDE that window.
// The window is a plain HTML document, not part of the Next.js bundle, so this
// adds no dependency to the application - which matters because a label printer
// is optional and most installs will never open this file.
//
// Paper: a barcode prints fine on ordinary receipt roll, but receipt paper has
// no adhesive. To stick labels on stock the shop needs an adhesive thermal roll
// of the same width; the printer itself needs no change.

import type { ReceiptPaperWidth } from '@/lib/transactions/receiptPrint'
import { getReceiptPaperWidth } from '@/lib/transactions/receiptPrint'

export interface LabelItem {
  name: string
  barcode: string
  price: number
  condition: string
  categoryName?: string
}

// Printable width is narrower than the roll - thermal heads leave a margin.
const PAPER = {
  58: { roll: '58mm', content: '50mm', name: 8, meta: 7, barH: 26, code: 8 },
  80: { roll: '80mm', content: '72mm', name: 10, meta: 8, barH: 32, code: 9 },
} as const

const peso = (value: number) =>
  '₱' + value.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string)
  )

/**
 * @param copies how many labels to print - normally the item's stock count,
 *               since every physical unit needs its own label.
 */
export const openLabelPrintWindow = (
  item: LabelItem,
  copies = 1,
  paperWidth: ReceiptPaperWidth = getReceiptPaperWidth()
) => {
  if (!item?.barcode) return

  const paper = PAPER[paperWidth]
  const count = Math.max(1, Math.min(200, Math.floor(copies)))

  const label = `
      <div class="label">
        <div class="name">${escapeHtml(item.name)}</div>
        <div class="meta">${escapeHtml(item.condition)}${
          item.categoryName ? ' · ' + escapeHtml(item.categoryName) : ''
        } · ${peso(item.price)}</div>
        <svg class="bars" jsbarcode-value="${escapeHtml(item.barcode)}"></svg>
      </div>`

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Labels — ${escapeHtml(item.name)}</title>
  <style>
    @page { size: ${paper.roll} auto; margin: 0; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: Arial, Helvetica, sans-serif;
      width: ${paper.roll};
      background: #fff;
      color: #000;
    }
    .label {
      width: ${paper.content};
      margin: 0 auto;
      padding: 3mm 0 4mm 0;
      text-align: center;
      /* A label split across a tear would be unscannable. */
      page-break-inside: avoid;
      break-inside: avoid;
      border-bottom: 1px dashed #bbb;
    }
    .name {
      font-size: ${paper.name}px;
      font-weight: 700;
      line-height: 1.2;
      margin-bottom: 1mm;
      overflow-wrap: anywhere;
    }
    .meta {
      font-size: ${paper.meta}px;
      margin-bottom: 1mm;
    }
    .bars { width: 100%; height: ${paper.barH}px; }

    @media print {
      /* Thermal printing is pure black or white - grey is dithered into dots,
         which is exactly what makes a barcode unreadable. */
      * {
        color: #000 !important;
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
        -webkit-font-smoothing: none;
      }
      .label { border-bottom: 1px dashed #000; }
    }
  </style>
</head>
<body>
  ${Array.from({ length: count }, () => label).join('')}

  <script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"><\/script>
  <script>
    // CODE128 keeps numeric codes compact. Six digits stays wide enough to scan
    // at 203 dpi; a longer code would print bars too narrow to read.
    window.addEventListener('load', function () {
      try {
        JsBarcode('.bars').init({
          format: 'CODE128',
          displayValue: true,
          fontSize: ${paper.code},
          textMargin: 1,
          margin: 0,
          height: ${paper.barH},
        });
      } catch (e) {
        document.body.insertAdjacentHTML(
          'afterbegin',
          '<p style="font:12px Arial;padding:8px">Barcode library could not load. ' +
          'Check the internet connection and try again.</p>'
        );
      }
      window.addEventListener('afterprint', function () { window.close(); });
      setTimeout(function () { window.print(); }, 400);
    });
  <\/script>
</body>
</html>`

  const printWindow = window.open('', '_blank', 'width=420,height=640')
  if (printWindow) {
    printWindow.document.write(html)
    printWindow.document.close()
  }
}
