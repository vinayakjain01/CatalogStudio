import type { Metadata } from 'next'
import Script from 'next/script'
import './globals.css'
import { Toaster } from '@/components/ui/sonner'

export const metadata: Metadata = {
  title: 'Catalog Studio',
  description: 'Catalog creative automation for Shopify → Meta',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased">
        {children}
        <Toaster />
        {/*
          strategy="beforeInteractive" injects the <script> tag into the initial
          server-rendered HTML — visible to Shopify's automated verifier bot which
          scans the page source before JS runs.

          Previously "afterInteractive" meant the script only appeared after hydration,
          so Shopify's bot could never confirm "Using the latest App Bridge script
          loaded from Shopify's CDN" and the check stayed stuck.
        */}
        <Script
          src="https://cdn.shopify.com/shopifycloud/app-bridge.js"
          data-api-key={process.env.NEXT_PUBLIC_SHOPIFY_CLIENT_ID ?? process.env.SHOPIFY_CLIENT_ID ?? ''}
          strategy="beforeInteractive"
        />
      </body>
    </html>
  )
}