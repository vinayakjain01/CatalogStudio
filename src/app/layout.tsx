import type { Metadata } from 'next'
import './globals.css'
import { Toaster } from '@/components/ui/sonner'

export const metadata: Metadata = {
  title: 'Catalog Studio',
  description: 'Catalog creative automation for Shopify → Meta',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const apiKey = process.env.NEXT_PUBLIC_SHOPIFY_CLIENT_ID
    ?? process.env.SHOPIFY_CLIENT_ID
    ?? ''

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/*
         * Shopify App Bridge — MUST be synchronous, MUST be first script.
         *
         * Problem with React 18 + Next.js App Router:
         *   React automatically adds async="true" to every external
         *   <script src="..."> element during SSR — even without the async prop.
         *   App Bridge explicitly checks its own script tag for async/defer and
         *   ABORTS initialization if found → window.shopify stays undefined forever.
         *   This was true for both strategy="afterInteractive" AND our raw <script> tag.
         *
         * Solution:
         *   1. <meta name="shopify-api-key"> — React renders meta tags correctly.
         *   2. Inline <script> (no src) — React never touches inline scripts.
         *      The inline script creates the App Bridge element with async=false
         *      and inserts it into the DOM immediately after itself.
         *      Browser executes it synchronously during HTML parsing.
         *      App Bridge checks script.async → false → PASSES → window.shopify defined.
         */}
        <meta name="shopify-api-key" content={apiKey} />
        <script
          dangerouslySetInnerHTML={{
            __html: `!function(){var s=document.createElement('script');s.src='https://cdn.shopify.com/shopifycloud/app-bridge.js';s.async=false;var c=document.currentScript;c.parentNode.insertBefore(s,c.nextSibling);}();`
          }}
        />
      </head>
      <body className="antialiased">
        {children}
        <Toaster />
      </body>
    </html>
  )
}