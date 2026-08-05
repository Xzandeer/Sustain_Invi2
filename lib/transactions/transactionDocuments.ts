// Transaction document types and helpers - generates receipts and reservation tickets
// Constants for receipt/ticket generation
export const STORE_NAME = 'JMGs JAPAN SURPLUS'
export const STORE_TAGLINE = 'Sales & Inventory'
export const SALES_THANK_YOU_NOTE = 'Thank you for your purchase.'
export const RESERVATION_NOTICE = 'Please present this ticket when claiming your reserved item.'
export const DEFAULT_CLAIM_INSTRUCTIONS =
  'Present this reservation ticket and a valid ID upon claiming your reserved item. Please claim within 3 days to avoid automatic release.'

export interface TransactionCustomerInfo {
  fullName: string
  email: string
  contactNumber: string
}

export interface TransactionLineItem {
  itemId: string
  name: string
  quantity: number
  price: number
  condition: string
  categoryName?: string
  subtotal: number
}

// Seller details required on a sales invoice.
//
// Under RA 11976 (Ease of Paying Taxes Act) and RR 7-2024 the invoice is the
// primary document for sales of goods, and must show the seller's registered
// name, TIN and business address. These are entered once by the owner in
// Settings and stamped onto each sale, so an invoice reprinted later still
// carries the details that applied when it was issued.
//
// Optional because they are blank until the shop enters them, and a sale must
// never fail because a settings field is empty.
export interface SellerDetails {
  sellerRegisteredName?: string
  sellerTin?: string
  sellerAddress?: string
}

export interface SaleReceiptDocument extends SellerDetails {
  type: 'sale'
  receiptNumber: string
  storeName: string
  storeTagline: string
  customer: TransactionCustomerInfo
  items: TransactionLineItem[]
  totalAmount: number
  transactionDate: string
  processedBy: string
  note: string
}

export interface ReservationTicketDocument {
  type: 'reservation'
  reservationCode: string
  storeName: string
  storeTagline: string
  customer: TransactionCustomerInfo
  items: TransactionLineItem[]
  reservationDate: string
  processedBy: string
  claimInstructions: string
  notice: string
}

export type CompletedTransactionDocument = SaleReceiptDocument | ReservationTicketDocument

export interface ReceiptRecord {
  id: string
  receiptNumber: string
  transactionType: 'sale' | 'reservation'
  transactionId: string
  customerName: string
  contactNumber: string
  items: Array<{
    itemId?: string
    name: string
    quantity: number
    price: number
    condition: string
    subtotal: number
  }>
  subtotal: number
  discount: number
  total: number
  cashierName: string
  createdAt: string
  status: 'active' | 'closed'
  document: SaleReceiptDocument | ReservationTicketDocument
}

// Format number as Philippine Peso currency
export const formatCurrency = (value: number) =>
  value.toLocaleString('en-PH', {
    style: 'currency',
    currency: 'PHP',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })

// Format timestamp as readable date/time (e.g. Jan 04, 2025 at 2:30 PM)
export const formatTransactionDateTime = (value: string | Date) =>
  new Date(value).toLocaleString('en-PH', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

// Helper: Encode string for URL parameters (replace spaces with +)
const encodeQueryValue = (value: string) => encodeURIComponent(value).replace(/%20/g, '+')

// Helper: Format sale items for email body (shows condition, qty, subtotal)
const formatSaleItemLines = (items: TransactionLineItem[]) =>
  items
    .map(
      (item, index) =>
        `${index + 1}. ${item.name}\n   Condition: ${item.condition}\n   Quantity: ${item.quantity}\n   Subtotal: ${formatCurrency(item.subtotal)}`
    )
    .join('\n\n')

// Helper: Format reservation items for email body (shows condition and quantity compactly)
const formatReservationItemLines = (items: TransactionLineItem[]) =>
  items.map((item, index) => `${index + 1}. ${item.name} (${item.condition}) x${item.quantity}`).join('\n')

// Build email subject line based on transaction type
export const buildManualEmailSubject = (document: CompletedTransactionDocument) =>
  document.type === 'sale'
    ? `Sales Invoice ${document.receiptNumber} - ${document.storeName}`
    : `Reservation Ticket ${document.reservationCode} - ${document.storeName}`

// Build email body with full transaction details
export const buildManualEmailBody = (document: CompletedTransactionDocument) => {
  const greeting = `Hello ${document.customer.fullName},`

  // Format for sales invoice
  if (document.type === 'sale') {
    return [
      greeting,
      '',
      'Thank you for your purchase.',
      '',
      'RECEIPT DETAILS',
      `Store Name: ${document.storeName}`,
      `Receipt Number: ${document.receiptNumber}`,
      `Customer Name: ${document.customer.fullName}`,
      `Transaction Date/Time: ${formatTransactionDateTime(document.transactionDate)}`,
      '',
      'ITEMS PURCHASED',
      formatSaleItemLines(document.items),
      '',
      'TOTAL AMOUNT',
      `${formatCurrency(document.totalAmount)}`,
      '',
      document.note,
      '',
      `Regards,`,
      document.storeName,
    ].join('\n')
  }

  // Format for reservation ticket
  return [
    greeting,
    '',
    'Thank you for choosing our store.',
    '',
    `Reservation Number: ${document.reservationCode}`,
    `Customer Name: ${document.customer.fullName}`,
    'Reserved Items:',
    formatReservationItemLines(document.items),
    `Reservation Date/Time: ${formatTransactionDateTime(document.reservationDate)}`,
    '',
    'Claim Instructions:',
    document.claimInstructions,
    '',
    document.notice,
    '',
    `Regards,`,
    document.storeName,
  ].join('\n')
}

// Generate mailto: link for default email client
export const buildMailtoLink = (document: CompletedTransactionDocument) => {
  const recipient = document.customer.email.trim()
  const params = new URLSearchParams({
    subject: buildManualEmailSubject(document),
    body: buildManualEmailBody(document),
  })

  return `mailto:${encodeURIComponent(recipient)}?${params.toString()}`
}

// Generate Gmail compose link (opens Gmail in browser)
export const buildGmailComposeLink = (document: CompletedTransactionDocument) => {
  const recipient = document.customer.email.trim()
  const subject = encodeQueryValue(buildManualEmailSubject(document))
  const body = encodeQueryValue(buildManualEmailBody(document))

  return `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeQueryValue(recipient)}&su=${subject}&body=${body}`
}
