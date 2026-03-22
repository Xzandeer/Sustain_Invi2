import 'server-only'
import { Resend } from 'resend'
import { STORE_NAME } from '@/lib/transactionDocuments'

export interface EmailLineItem {
  name: string
  quantity: number
  price: number
  condition?: string
}

export interface InvoiceEmailPayload {
  invoiceNumber: string
  customerName: string
  customerEmail: string
  customerContactNumber: string
  items: EmailLineItem[]
  totalAmount: number
  transactionDate: string
  processedBy: string
}

export interface ReservationTicketEmailPayload {
  reservationCode: string
  customerName: string
  customerEmail: string
  customerContactNumber: string
  items: Array<Pick<EmailLineItem, 'name' | 'quantity' | 'condition'>>
  reservationDate: string
  claimInstructions: string
  processedBy: string
}

export interface EmailSendResult {
  sent: boolean
  message: string
  status: 'sent' | 'skipped' | 'failed'
}

const currency = (value: number) =>
  value.toLocaleString('en-PH', {
    style: 'currency',
    currency: 'PHP',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')

interface EmailConfiguration {
  from: string
}

const getEmailConfiguration = (): EmailConfiguration | null => {
  const from = process.env.EMAIL_FROM?.trim() || ''

  if (!from) {
    console.warn('[email] Email sending skipped because EMAIL_FROM is missing.')
    return null
  }

  return { from }
}

const sendEmail = async (options: {
  to: string
  subject: string
  html: string
  text: string
}): Promise<EmailSendResult> => {
  const emailConfig = getEmailConfiguration()

  if (!emailConfig) {
    return {
      sent: false,
      status: 'skipped',
      message: 'Email is not configured on the server, so the transaction was saved without sending an email.',
    }
  }

  const apiKey = process.env.RESEND_API_KEY?.trim()
  if (!apiKey) {
    console.warn('[email] Email sending skipped because RESEND_API_KEY is missing.')
    return {
      sent: false,
      status: 'skipped',
      message: 'Email is not configured on the server, so the transaction was saved without sending an email.',
    }
  }

  try {
    const resend = new Resend(apiKey)
    const { error } = await resend.emails.send({
      from: emailConfig.from,
      to: [options.to],
      subject: options.subject,
      html: options.html,
      text: options.text,
    })

    if (error) {
      console.error('[email] Resend send failed:', {
        message: error.message,
        code: 'name' in error ? error.name : undefined,
        command: 'resend.emails.send',
      })
      return {
        sent: false,
        status: 'failed',
        message: getUserFriendlyEmailError(error.message),
      }
    }

    return {
      sent: true,
      status: 'sent',
      message: 'Email sent successfully.',
    }
  } catch (error) {
    console.error('[email] Email send failed:', {
      message: error instanceof Error ? error.message : 'Unknown error',
      code:
        error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
          ? (error as { code: string }).code
          : undefined,
      command: 'resend.emails.send',
    })
    const message = error instanceof Error ? getUserFriendlyEmailError(error.message) : 'Email could not be sent, but the transaction was saved.'
    return {
      sent: false,
      status: 'failed',
      message,
    }
  }
}

const getUserFriendlyEmailError = (message: string) => {
  const normalized = message.toLowerCase()

  if (normalized.includes('self-signed certificate') || normalized.includes('certificate')) {
    return 'Email could not be sent because the server rejected the mail certificate. The transaction was saved.'
  }

  if (normalized.includes('invalid login') || normalized.includes('authentication unsuccessful')) {
    return 'Email could not be sent because the Gmail login details are invalid. The transaction was saved.'
  }

  if (normalized.includes('api key') || normalized.includes('unauthorized')) {
    return 'Email could not be sent because the email service credentials are invalid. The transaction was saved.'
  }

  if (normalized.includes('domain') || normalized.includes('sender')) {
    return 'Email could not be sent because the sender address is not verified with the email service. The transaction was saved.'
  }

  return 'Email could not be sent right now, but the transaction was saved.'
}

export const sendInvoiceEmail = async (payload: InvoiceEmailPayload) => {
  const rowsHtml = payload.items
    .map(
      (item, index) => `
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #e2e8f0;color:#0f172a;">${index + 1}</td>
          <td style="padding:10px 0;border-bottom:1px solid #e2e8f0;">${escapeHtml(item.name)}</td>
          <td style="padding:10px 0;border-bottom:1px solid #e2e8f0;">${escapeHtml(item.condition ?? 'N/A')}</td>
          <td style="padding:10px 0;border-bottom:1px solid #e2e8f0;text-align:center;">${item.quantity}</td>
          <td style="padding:10px 0;border-bottom:1px solid #e2e8f0;text-align:right;">${currency(item.price)}</td>
          <td style="padding:8px 0;border-bottom:1px solid #e2e8f0;text-align:right;">${currency(
            item.quantity * item.price
          )}</td>
        </tr>`
    )
    .join('')

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:720px;margin:0 auto;color:#0f172a;background:#ffffff;">
      <div style="padding:24px 24px 12px;border:1px solid #e2e8f0;border-radius:16px;">
        <p style="margin:0 0 4px;font-size:22px;font-weight:700;color:#0f172a;">${escapeHtml(STORE_NAME)}</p>
        <p style="margin:0;color:#475569;font-size:13px;">Official Sales Receipt</p>
        <p style="margin:24px 0 0;">Hello ${escapeHtml(payload.customerName)},</p>
        <p style="margin:8px 0 0;color:#334155;">Thank you for your purchase. Here is your receipt for this transaction.</p>

        <div style="margin-top:24px;">
          <p style="margin:0 0 10px;font-size:13px;font-weight:700;letter-spacing:0.04em;color:#475569;">RECEIPT DETAILS</p>
          <table style="width:100%;border-collapse:collapse;margin-bottom:8px;">
            <tbody>
              <tr><td style="padding:4px 0;width:180px;"><strong>Store Name</strong></td><td style="padding:4px 0;">${escapeHtml(STORE_NAME)}</td></tr>
              <tr><td style="padding:4px 0;"><strong>Receipt Number</strong></td><td style="padding:4px 0;">${escapeHtml(payload.invoiceNumber)}</td></tr>
              <tr><td style="padding:4px 0;"><strong>Customer Name</strong></td><td style="padding:4px 0;">${escapeHtml(payload.customerName)}</td></tr>
              <tr><td style="padding:4px 0;"><strong>Transaction Date/Time</strong></td><td style="padding:4px 0;">${escapeHtml(payload.transactionDate)}</td></tr>
            </tbody>
          </table>
        </div>

        <div style="margin-top:20px;">
          <p style="margin:0 0 10px;font-size:13px;font-weight:700;letter-spacing:0.04em;color:#475569;">ITEMS PURCHASED</p>
          <table style="width:100%;border-collapse:collapse;">
            <thead>
              <tr>
                <th style="padding:10px 0;border-bottom:1px solid #cbd5e1;text-align:left;">#</th>
                <th style="padding:10px 0;border-bottom:1px solid #cbd5e1;text-align:left;">Item</th>
                <th style="padding:10px 0;border-bottom:1px solid #cbd5e1;text-align:left;">Condition</th>
                <th style="padding:10px 0;border-bottom:1px solid #cbd5e1;text-align:center;">Qty</th>
                <th style="padding:10px 0;border-bottom:1px solid #cbd5e1;text-align:right;">Price</th>
                <th style="padding:10px 0;border-bottom:1px solid #cbd5e1;text-align:right;">Subtotal</th>
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>

        <div style="margin-top:24px;padding:16px 18px;border-radius:14px;background:#eff6ff;border:1px solid #bfdbfe;">
          <p style="margin:0 0 6px;font-size:13px;font-weight:700;letter-spacing:0.04em;color:#1d4ed8;">TOTAL AMOUNT</p>
          <p style="margin:0;font-size:24px;font-weight:700;color:#0f172a;">${currency(payload.totalAmount)}</p>
        </div>

        <p style="margin:24px 0 0;color:#334155;">Regards,</p>
        <p style="margin:4px 0 0;font-weight:700;color:#0f172a;">${escapeHtml(STORE_NAME)}</p>
      </div>
    </div>
  `

  const textItems = payload.items
    .map(
      (item, index) =>
        `${index + 1}. ${item.name}\n   Condition: ${item.condition ?? 'N/A'}\n   Quantity: ${item.quantity}\n   Subtotal: ${currency(item.quantity * item.price)}`
    )
    .join('\n\n')

  return sendEmail({
    to: payload.customerEmail,
    subject: `Invoice ${payload.invoiceNumber}`,
    html,
    text: [
      `Hello ${payload.customerName},`,
      '',
      'Thank you for your purchase.',
      '',
      'RECEIPT DETAILS',
      `Store Name: ${STORE_NAME}`,
      `Receipt Number: ${payload.invoiceNumber}`,
      `Customer Name: ${payload.customerName}`,
      `Transaction Date/Time: ${payload.transactionDate}`,
      '',
      'ITEMS PURCHASED',
      textItems,
      '',
      'TOTAL AMOUNT',
      `${currency(payload.totalAmount)}`,
      '',
      'Regards,',
      STORE_NAME,
    ].join('\n'),
  })
}

export const sendReservationTicketEmail = async (payload: ReservationTicketEmailPayload) => {
  const rowsHtml = payload.items
    .map(
      (item) => `
        <li style="margin-bottom:8px;">
          ${escapeHtml(item.name)}${item.condition ? ` (${escapeHtml(item.condition)})` : ''} - Qty ${item.quantity}
        </li>`
    )
    .join('')

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:720px;margin:0 auto;color:#0f172a;">
      <h2 style="margin-bottom:4px;">Reservation Ticket</h2>
      <p style="margin:0 0 24px;color:#475569;">Reservation ${escapeHtml(payload.reservationCode)}</p>
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
        <tbody>
          <tr><td style="padding:4px 0;"><strong>Customer</strong></td><td style="padding:4px 0;">${escapeHtml(payload.customerName)}</td></tr>
          <tr><td style="padding:4px 0;"><strong>Email</strong></td><td style="padding:4px 0;">${escapeHtml(payload.customerEmail)}</td></tr>
          <tr><td style="padding:4px 0;"><strong>Contact Number</strong></td><td style="padding:4px 0;">${escapeHtml(payload.customerContactNumber)}</td></tr>
          <tr><td style="padding:4px 0;"><strong>Reservation Date</strong></td><td style="padding:4px 0;">${escapeHtml(payload.reservationDate)}</td></tr>
          <tr><td style="padding:4px 0;"><strong>Processed By</strong></td><td style="padding:4px 0;">${escapeHtml(payload.processedBy)}</td></tr>
        </tbody>
      </table>
      <h3 style="margin-bottom:8px;">Reserved Items</h3>
      <ul style="padding-left:20px;margin-top:0;">${rowsHtml}</ul>
      <div style="margin-top:24px;padding:16px;border:1px solid #cbd5e1;border-radius:12px;background:#f8fafc;">
        <strong>Claim Instructions</strong>
        <p style="margin:8px 0 0;">${escapeHtml(payload.claimInstructions)}</p>
      </div>
    </div>
  `

  const textItems = payload.items
    .map((item) => `${item.name}${item.condition ? ` (${item.condition})` : ''} | Qty: ${item.quantity}`)
    .join('\n')

  return sendEmail({
    to: payload.customerEmail,
    subject: `Reservation Ticket ${payload.reservationCode}`,
    html,
    text: [
      `Reservation Code: ${payload.reservationCode}`,
      `Customer Name: ${payload.customerName}`,
      `Customer Email: ${payload.customerEmail}`,
      `Contact Number: ${payload.customerContactNumber}`,
      `Reservation Date: ${payload.reservationDate}`,
      `Processed By: ${payload.processedBy}`,
      '',
      textItems,
      '',
      `Claim Instructions: ${payload.claimInstructions}`,
    ].join('\n'),
  })
}
