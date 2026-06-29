import type { Metadata } from 'next'
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
          Shopify App Bridge — MUST have data-api-key for the embedded app
          checks to pass. Without this attribute Shopify's automated scanner
          cannot verify that your app uses App Bridge from their CDN.
          The data-api-key is your Shopify Client ID (public, safe to expose).
        */}
        {/* eslint-disable-next-line @next/next/no-sync-scripts */}
        <script
          src="https://cdn.shopify.com/shopifycloud/app-bridge.js"
          data-api-key={process.env.NEXT_PUBLIC_SHOPIFY_CLIENT_ID ?? process.env.SHOPIFY_CLIENT_ID}
        />
      </head>
      <body className="antialiased">
        {children}
        <Toaster />
      </body>
    </html>
  )
}