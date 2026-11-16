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
  icons: {
    icon: [
      {
        url: '/icon-light-32x32.png',
        media: '(prefers-color-scheme: light)',
      },
      {
        url: '/icon-dark-32x32.png',
        media: '(prefers-color-scheme: dark)',
      },
      {
        url: '/icon.svg',
        type: 'image/svg+xml',
      },
    ],
    apple: '/apple-icon.png',
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
