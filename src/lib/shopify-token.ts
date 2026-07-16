/**
 * Shopify token exchange + session-token helpers.
 *
 * Shopify no longer accepts non-expiring offline access tokens for the Admin API
 * (you'll see: "[API] Non-expiring access tokens are no longer accepted ...").
 * The supported way to get an *expiring* offline token is OAuth token exchange:
 * trade the short-lived session token (`id_token`) that App Bridge / the embedded
 * launch gives us for a fresh offline access token.
 *
 * Docs: https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/token-exchange
 */

// ── Constants ────────────────────────────────────────────────────────────────

const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange'
const ID_TOKEN_TYPE        = 'urn:ietf:params:oauth:token-type:id_token'
const OFFLINE_TOKEN_TYPE   = 'urn:shopify:params:oauth:token-type:offline-access-token'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OfflineTokenResult {
  access_token: string
  scope: string
  expires_in?: number
}

// ── Server-side: token exchange (used in /api/shopify/auth) ──────────────────

/**
 * Exchange a Shopify session token (id_token) for an expiring offline access
 * token for the given shop. Throws on failure with the Shopify response body.
 *
 * Called server-side from src/app/api/shopify/auth/route.ts.
 */
export async function exchangeSessionTokenForOfflineToken(
  shop: string,
  idToken: string
): Promise<OfflineTokenResult> {
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id:            process.env.SHOPIFY_CLIENT_ID,
      client_secret:        process.env.SHOPIFY_CLIENT_SECRET,
      grant_type:           TOKEN_EXCHANGE_GRANT,
      subject_token:        idToken,
      subject_token_type:   ID_TOKEN_TYPE,
      requested_token_type: OFFLINE_TOKEN_TYPE,
    }),
  })

  const text = await res.text()
  if (!res.ok) {
    throw new Error(`Token exchange failed (${res.status}): ${text}`)
  }

  const data = JSON.parse(text)
  if (!data.access_token) {
    throw new Error(`Token exchange returned no access_token: ${text}`)
  }

  return {
    access_token: data.access_token,
    scope:        data.scope ?? '',
    expires_in:   data.expires_in,
  }
}

// ── Client-side: session token helpers (satisfies Shopify's review checks) ───

/**
 * Returns the current Shopify session token from App Bridge, or null if
 * App Bridge is unavailable (e.g. running outside the Shopify admin iframe).
 *
 * Satisfies the Shopify App Store check:
 *   "Using session tokens for user authentication"
 */
export async function getShopifySessionToken(): Promise<string | null> {
  try {
    if (typeof window === 'undefined') return null
    const shopify = (window as any).shopify
    if (typeof shopify?.idToken !== 'function') return null
    return await shopify.idToken()
  } catch {
    return null
  }
}

/**
 * Drop-in replacement for fetch() that automatically attaches the Shopify
 * session token as a Bearer token in the Authorization header.
 * Falls back to a plain fetch if App Bridge is unavailable (local dev, etc.).
 *
 * @example
 *   import { shopifyFetch } from '@/lib/shopify-token'
 *   const res = await shopifyFetch('/api/generate/enqueue', {
 *     method: 'POST',
 *     body: JSON.stringify({ storeId }),
 *   })
 */
export async function shopifyFetch(
  input: RequestInfo | URL,
  init: RequestInit = {}
): Promise<Response> {
  const token = await getShopifySessionToken()

  const headers = new Headers(init.headers)
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  if (token) {
    headers.set('Authorization', `Bearer ${token}`)
  }

  return fetch(input, { ...init, headers })
}