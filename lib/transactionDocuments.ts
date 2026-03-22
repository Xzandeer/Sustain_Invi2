export const STORE_NAME = 'JMGS JAPON SURPLUS'
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

export interface SaleReceiptDocument {
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

export const formatCurrency = (value: number) =>
  value.toLocaleString('en-PH', {
    style: 'currency',
    currency: 'PHP',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })

export const formatTransactionDateTime = (value: string | Date) =>
  new Date(value).toLocaleString('en-PH', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

const encodeQueryValue = (value: string) => encodeURIComponent(value).replace(/%20/g, '+')

const formatItemLines = (items: TransactionLineItem[]) =>
  items.map((item) => `- ${item.name} (${item.condition}) x${item.quantity}`).join('\n')

export const buildManualEmailSubject = (document: CompletedTransactionDocument) =>
  document.type === 'sale'
    ? `Sales Receipt ${document.receiptNumber} - ${document.storeName}`
    : `Reservation Ticket ${document.reservationCode} - ${document.storeName}`

export const buildManualEmailBody = (document: CompletedTransactionDocument) => {
  const greeting = `Hello ${document.customer.fullName},`
  const intro =
    document.type === 'sale'
      ? 'Here is your sales receipt. This email was prepared for manual sending through your email client.'
      : 'Here is your reservation ticket. This email was prepared for manual sending through your email client.'

  if (document.type === 'sale') {
    return [
      greeting,
      '',
      intro,
      '',
      `Receipt Number: ${document.receiptNumber}`,
      `Customer Name: ${document.customer.fullName}`,
      'Items:',
      formatItemLines(document.items),
      `Total Amount: ${formatCurrency(document.totalAmount)}`,
      `Transaction Date/Time: ${formatTransactionDateTime(document.transactionDate)}`,
      '',
      document.note,
    ].join('\n')
  }

  return [
    greeting,
    '',
    intro,
    '',
    `Reservation Number: ${document.reservationCode}`,
    `Customer Name: ${document.customer.fullName}`,
    'Reserved Items:',
    formatItemLines(document.items),
    `Reservation Date/Time: ${formatTransactionDateTime(document.reservationDate)}`,
    '',
    'Claim Instructions:',
    document.claimInstructions,
    '',
    document.notice,
  ].join('\n')
}

export const buildMailtoLink = (document: CompletedTransactionDocument) => {
  const recipient = document.customer.email.trim()
  const params = new URLSearchParams({
    subject: buildManualEmailSubject(document),
    body: buildManualEmailBody(document),
  })

  return `mailto:${encodeURIComponent(recipient)}?${params.toString()}`
}

export const buildGmailComposeLink = (document: CompletedTransactionDocument) => {
  const recipient = document.customer.email.trim()
  const subject = encodeQueryValue(buildManualEmailSubject(document))
  const body = encodeQueryValue(buildManualEmailBody(document))

  return `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeQueryValue(recipient)}&su=${subject}&body=${body}`
}
