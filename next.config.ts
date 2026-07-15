import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  serverExternalPackages: ['@napi-rs/canvas'],
  compress: true,
  poweredByHeader: false,

  experimental: {
    serverActions: {
      bodySizeLimit: '10mb',
    },
  },

  async headers() {
    return [
      {
        source: '/_next/static/(.*)',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
      },
      {
        source: '/(.*)\\.(ico|png|jpg|jpeg|webp|svg|woff|woff2|ttf|otf)',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=86400, stale-while-revalidate=604800' }],
      },
      {
        source: '/(.*)',
        headers: [
          {
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
          { key: 'X-Frame-Options', value: 'ALLOWALL' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ]
  },
}

export default nextConfig