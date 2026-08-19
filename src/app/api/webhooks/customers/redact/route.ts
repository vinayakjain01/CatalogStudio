/**
 * POST /api/webhooks/customers/redact
 *
 * Shopify's mandatory GDPR webhook: fired 10 days after a customer erasure
 * request, asking the app to delete that customer's data. Craftify stores no
 * individual customer PII (only product catalog + generated creatives at the
 * store level), so there is nothing to erase.
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

// GDPR: delete a specific customer's data. This app stores no individual
// customer PII (only product catalog + generated creatives at the store level),
// so there is nothing to erase. We still verify HMAC and respond 200.
export async function POST(request: NextRequest) {
  const rawBody = await request.text()
  const hmac = request.headers.get('x-shopify-hmac-sha256')

  if (!verifyShopifyWebhook(rawBody, hmac)) {
    return new NextResponse('Unauthorized', { status: 401 })
  }

  // No customer-level PII stored — nothing to redact.
  return new NextResponse('OK', { status: 200 })
}