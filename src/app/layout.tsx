import type { Metadata } from 'next'
import Script from 'next/script'
import './globals.css'
import { Toaster } from '@/components/ui/sonner'

export const metadata: Metadata = {
  title: 'CatalogCreative',
  description: 'Catalog creative automation for Shopify → Meta',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased">
        {children}
        <Toaster />
        {/*
          next/script with strategy="afterInteractive" loads AFTER hydration
          so it never blocks HTML parsing — unlike the old raw <script> tag.
        */}
        <Script
          src="https://cdn.shopify.com/shopifycloud/app-bridge.js"
          data-api-key={process.env.NEXT_PUBLIC_SHOPIFY_CLIENT_ID ?? process.env.SHOPIFY_CLIENT_ID ?? ''}
          strategy="afterInteractive"
        />
      </body>
    </html>
  )
}