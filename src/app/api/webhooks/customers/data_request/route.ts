import { NextRequest, NextResponse } from 'next/server'
import { verifyShopifyWebhook } from '@/lib/shopify-webhook'

export const runtime = 'nodejs'

// GDPR: a customer requested their data. Shopify requires this endpoint to
// exist, verify HMAC, and respond 200. We store no individual customer PII
// (only store-level product catalog data), so there is nothing to return —
// but we must still acknowledge correctly.
export async function POST(request: NextRequest) {
  const rawBody = await request.text()
  const hmac = request.headers.get('x-shopify-hmac-sha256')

  if (!verifyShopifyWebhook(rawBody, hmac)) {
    return new NextResponse('Unauthorized', { status: 401 })
  }

  // No customer-level PII is stored by this app — nothing to compile.
  // (If that changes, gather and deliver the customer's data here.)
  return new NextResponse('OK', { status: 200 })
}