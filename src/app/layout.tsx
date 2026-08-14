import type { Metadata } from 'next'
import { Fraunces, Manrope } from 'next/font/google'
import './globals.css'
import { Toaster } from '@/components/ui/sonner'

/**
 * Fraunces for headings, Manrope for UI.
 *
 * next/font self-hosts these at build time. That is not a preference: the CSP
 * in next.config.ts sets `font-src 'self'` and `style-src 'self'`, so a
 * <link> to fonts.googleapis.com would be blocked outright and the page would
 * silently fall back to system fonts.
 */
const fraunces = Fraunces({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-heading-family',
  display: 'swap',
})

const manrope = Manrope({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-sans-family',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Catalog Studio',
  description: 'Catalog creative automation for Shopify → Meta',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Server Component, so the non-public var is readable here too; the client id
  // is public regardless (it appears in every OAuth URL). An empty value would
  // make App Bridge silently abort and never issue a session token.
  const apiKey =
    process.env.NEXT_PUBLIC_SHOPIFY_CLIENT_ID
    ?? process.env.SHOPIFY_CLIENT_ID
    ?? ''

  return (
    <html lang="en" suppressHydrationWarning className={`${manrope.variable} ${fraunces.variable}`}>
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