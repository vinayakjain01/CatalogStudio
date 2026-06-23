import type { NextConfig } from "next"

/**
 * next.config.ts
 *
 * Key additions for Shopify embedded app compliance:
 *
 * 1. frame-ancestors — allows Shopify Admin to embed the app in an iframe.
 *    Without this the browser blocks the iframe and the app shows blank.
 *
 * 2. script-src — allows Shopify's App Bridge CDN script to load.
 *    Shopify checks that cdn.shopify.com is in the CSP.
 *
 * 3. Remove the default X-Frame-Options: SAMEORIGIN header Next.js sets,
 *    because it conflicts with the Shopify iframe.
 */

const nextConfig: NextConfig = {
  serverExternalPackages: ['@napi-rs/canvas'],

  async headers() {
    return [
      {
        // Apply to all routes
        source: '/(.*)',
        headers: [
          {
            // Allow Shopify Admin to embed this app in an iframe.
            // Also allow *.myshopify.com and admin.shopify.com.
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.shopify.com",
              "style-src 'self' 'unsafe-inline'",
              "img-src * data: blob:",
              "font-src 'self' data:",
              "connect-src *",
              "frame-ancestors https://*.myshopify.com https://admin.shopify.com",
            ].join('; '),
          },
          {
            // Next.js adds X-Frame-Options: SAMEORIGIN by default.
            // This MUST be removed for Shopify iframe embedding to work.
            // The frame-ancestors CSP directive above replaces it securely.
            key: 'X-Frame-Options',
            value: 'ALLOWALL',
          },
        ],
      },
    ]
  },
}

export default nextConfig