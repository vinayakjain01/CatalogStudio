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
  title: 'Craftify',
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
         * Shopify App Bridge.
         *
         * Loaded by an inline script rather than a rendered <script src> or
         * next/script, because App Bridge ABORTS if its own tag is async or
         * deferred — and every React/Next mechanism adds one:
         *   <script src> rendered in head  -> lands after ~10 Next chunks
         *   next/script beforeInteractive  -> emits only a <link preload>
         *   ReactDOM.preinit               -> emits async=""
         * (All three verified against the built HTML, not assumed.)
         *
         * An inline script is untouched by React, so it runs during parsing and
         * inserts app-bridge.js with async=false — which is what actually gets
         * window.shopify defined. Confirmed working: token exchange succeeds,
         * and that requires an id_token that only App Bridge can mint.
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