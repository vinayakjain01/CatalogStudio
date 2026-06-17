import crypto from 'crypto'

// Verify a Shopify webhook's authenticity.
//
// Webhook HMAC is DIFFERENT from OAuth HMAC:
//  - It is computed over the RAW request body (exact bytes, unparsed).
//  - It is sent base64-encoded in the `X-Shopify-Hmac-Sha256` header.
//  - It is keyed with the app's client secret (SHOPIFY_CLIENT_SECRET).
//
// Shopify's automated review explicitly tests that webhooks are rejected when
// the signature is missing or invalid, so callers MUST verify before acting.
export function verifyShopifyWebhook(rawBody: string, hmacHeader: string | null): boolean {
  if (!hmacHeader) return false
  const secret = process.env.SHOPIFY_CLIENT_SECRET
  if (!secret) return false

  const digest = crypto
    .createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('base64')

  // Length-check guards timingSafeEqual against throwing on mismatched sizes.
  const a = Buffer.from(digest)
  const b = Buffer.from(hmacHeader)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}