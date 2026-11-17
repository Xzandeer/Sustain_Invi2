// Root layout - fonts, global styles, theme provider and the toast container.
// Wraps every page in the app, including login and signup.

import type { Metadata } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import { Analytics } from '@vercel/analytics/next'
import './globals.css'
import { Toaster } from '@/components/ui/sonner'
import SessionGuard from '@/components/shared/SessionGuard'

// Geist for the whole app. Exposed as --font-geist, which globals.css maps to
// Tailwind's font-sans.
const geist = Geist({ subsets: ['latin'], variable: '--font-geist' })
const _geistMono = Geist_Mono({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'SUSTAIN - Inventory & Sales Tracking',
  description: 'Surplus Shop Inventory & Sales Tracking System',
  generator: 'v0.app',
  // The shop logo is the only icon file in /public; the old icon-*.png and
  // icon.svg entries pointed at files that do not exist (two 404s per page).
  icons: {
    icon: '/Logo.png',
    apple: '/Logo.png',
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className={geist.variable}>
      <body className="font-sans antialiased bg-slate-100">
        {children}
        <SessionGuard />
        <Toaster richColors position="top-right" />
        <Analytics />
      </body>
    </html>
  )
}
