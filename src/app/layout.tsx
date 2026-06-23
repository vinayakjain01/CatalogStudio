import type { Metadata } from 'next'
import Script from 'next/script'
import './globals.css'
import { Toaster } from '@/components/ui/sonner'

export const metadata: Metadata = {
  title: 'CatalogCreative',
  description: 'Catalog creative automation for Shopify → Meta',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/*
          Shopify App Bridge — loaded from Shopify's CDN.
          This is REQUIRED for:
          • The "Using the latest App Bridge script" embedded app check to pass
          • Session token authentication (replaces cookie-based auth in iframes)
          • App Bridge UI controls (navigation, modals, etc.) to work
          Loading strategy: beforeInteractive ensures it's available before any page JS.
        */}
        <Script
          src="https://cdn.shopify.com/shopifycloud/app-bridge.js"
          strategy="beforeInteractive"
        />
      </head>
      <body className="antialiased">
        {children}
        <Toaster />
      </body>
    </html>
  )
}