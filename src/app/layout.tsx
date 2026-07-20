import type { Metadata } from 'next'
import './globals.css'
import { Toaster } from '@/components/ui/sonner'

export const metadata: Metadata = {
  title: 'Catalog Studio',
  description: 'Catalog creative automation for Shopify → Meta',
}

const API_KEY = process.env.NEXT_PUBLIC_SHOPIFY_CLIENT_ID
  ?? process.env.SHOPIFY_CLIENT_ID
  ?? ''

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/*
         * ─── Shopify App Bridge — CRITICAL ORDERING ──────────────────────────
         *
         * Both checks in the Shopify Partner Dashboard require:
         *
         *  1. App Bridge loaded from Shopify's CDN as the VERY FIRST script.
         *  2. Session tokens (window.shopify.idToken()) available and used in
         *     requests to your backend.
         *
         * WHY raw <script> and NOT next/script:
         *   next/script's "beforeInteractive" strategy still injects an `async`
         *   attribute in some Next.js App Router builds. App Bridge explicitly
         *   checks for async/defer/type=module and ABORTS if found:
         *     "The script tag loading App Bridge has `async` — Aborting."
         *   That abort leaves window.shopify = undefined forever, so no session
         *   tokens ever fire and both Shopify checks stay permanently stuck.
         *
         *   A raw <script> tag placed directly in <head> is ALWAYS synchronous
         *   and is the first thing the browser parses — guaranteed correct.
         *
         * Step 1: <meta name="shopify-api-key"> — App Bridge reads the key here.
         * Step 2: <script> CDN — synchronous, no async / defer / type=module.
         *
         * Docs: https://shopify.dev/docs/api/app-home/app-bridge-web-components
         */}
        <meta name="shopify-api-key" content={API_KEY} />
        {/* eslint-disable-next-line @next/next/no-sync-scripts */}
        <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js" />
      </head>
      <body className="antialiased">
        {children}
        <Toaster />
      </body>
    </html>
  )
}