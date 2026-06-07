import { NextRequest, NextResponse } from 'next/server'
import { sendInvoiceEmail, sendReservationTicketEmail } from '@/lib/server/email'

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as Record<string, unknown>
    const type = body.type as string

    if (type === 'sale') {
      const result = await sendInvoiceEmail({
        invoiceNumber: String(body.invoiceNumber ?? ''),
        customerName: String(body.customerName ?? 'Valued Customer'),
        customerEmail: String(body.customerEmail ?? ''),
        customerContactNumber: String(body.customerContactNumber ?? ''),
        items: (body.items as Array<{ name: string; quantity: number; price: number; condition?: string }>) ?? [],
        totalAmount: Number(body.totalAmount ?? 0),
        transactionDate: String(body.transactionDate ?? new Date().toISOString()),
        processedBy: String(body.processedBy ?? 'JMGS Staff'),
      })
      return NextResponse.json(result, { status: result.sent ? 200 : 500 })
    }

    if (type === 'reservation') {
      const result = await sendReservationTicketEmail({
        reservationCode: String(body.reservationCode ?? ''),
        customerName: String(body.customerName ?? 'Valued Customer'),
        customerEmail: String(body.customerEmail ?? ''),
        customerContactNumber: String(body.customerContactNumber ?? ''),
        items: (body.items as Array<{ name: string; quantity: number; condition?: string }>) ?? [],
        reservationDate: String(body.reservationDate ?? new Date().toISOString()),
        claimInstructions: String(body.claimInstructions ?? 'Please claim your reserved items within the reservation period.'),
        processedBy: String(body.processedBy ?? 'JMGS Staff'),
      })
      return NextResponse.json(result, { status: result.sent ? 200 : 500 })
    }

    return NextResponse.json({ error: 'Invalid email type.' }, { status: 400 })
  } catch (error) {
    console.error('POST /api/email error:', error)
    return NextResponse.json({ error: 'Failed to send email.' }, { status: 500 })
  }
}
