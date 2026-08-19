/**
 * POST /api/webhooks/customers/data_request
 *
 * Shopify's mandatory GDPR webhook: fired when a customer asks a shop for a
 * copy of their data. Craftify stores no individual customer PII (only
 * store-level product catalog data), so there is nothing to compile — this
 * endpoint exists to satisfy Shopify's app-review requirement to acknowledge it.
 *
 * Auth:     HMAC signature verification via verifyShopifyWebhook() against the
 *           raw request body and the X-Shopify-Hmac-Sha256 header (no session/bearer auth)
 * Returns:  200 "OK" when the HMAC is valid; 401 "Unauthorized" when it isn't
 *
 * Flow: read raw body -> verify HMAC -> no-op (no PII stored) -> respond 200
 */
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