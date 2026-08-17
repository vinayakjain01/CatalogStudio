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
  refresh_token?: string
  refresh_token_expires_in?: number
}

/**
 * Asks Shopify for an EXPIRING offline token.
 *
 * Shopify introduced expiring offline tokens in Dec 2025 and now rejects the
 * non-expiring kind outright:
 *   "[API] Non-expiring access tokens are no longer accepted."
 *
 * Crucially, expiring is OPT-IN per request — omit this and Shopify happily
 * returns a non-expiring token that every Admin API call then 403s on. That was
 * the actual cause of the reconnect loop: reinstalling and token exchange both
 * "succeeded" and both handed back an unusable token, because neither request
 * asked for an expiring one.
 *
 * Expiring tokens live 1 hour and come with a 90-day refresh token.
 */
const EXPIRING = '1'

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
      expiring:             EXPIRING,
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

  // No expires_in means Shopify ignored `expiring` and issued a non-expiring
  // token, which the Admin API will reject on the very next call. Better to fail
  // here, where the reason is obvious, than to store it and debug 403s later.
  if (!data.expires_in) {
    throw new Error(
      'Shopify returned a NON-EXPIRING token despite expiring=1. ' +
      'The Admin API rejects these; check the app is on Shopify managed installation.'
    )
  }

  return {
    access_token:             data.access_token,
    scope:                    data.scope ?? '',
    expires_in:               data.expires_in,
    refresh_token:            data.refresh_token,
    refresh_token_expires_in: data.refresh_token_expires_in,
  }
}

/**
 * Trade a refresh token for a fresh access token.
 *
 * Expiring access tokens last only 1 hour, so anything running outside a live
 * browser session — the cron sync, the BullMQ worker — will hold an expired one
 * almost always. The refresh token lasts 90 days and is the only way those paths
 * stay authenticated.
 *
 * Shopify rotates both tokens: the returned refresh_token replaces the old one,
 * which is invalidated immediately, so the new value MUST be persisted.
 */
export async function refreshOfflineToken(
  shop: string,
  refreshToken: string
): Promise<OfflineTokenResult> {
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id:     process.env.SHOPIFY_CLIENT_ID,
      client_secret: process.env.SHOPIFY_CLIENT_SECRET,
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
    }),
  })

  const text = await res.text()
  if (!res.ok) {
    throw new Error(`Token refresh failed (${res.status}): ${text}`)
  }

  const data = JSON.parse(text)
  if (!data.access_token) {
    throw new Error(`Token refresh returned no access_token: ${text}`)
  }

  return {
    access_token:             data.access_token,
    scope:                    data.scope ?? '',
    expires_in:               data.expires_in,
    refresh_token:            data.refresh_token,
    refresh_token_expires_in: data.refresh_token_expires_in,
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

  // Never set Content-Type for FormData: the browser must generate it itself so
  // it can append the multipart boundary. Forcing application/json here silently
  // breaks every file upload.
  const isFormData = typeof FormData !== 'undefined' && init.body instanceof FormData
  if (!isFormData && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  if (token) {
    headers.set('Authorization', `Bearer ${token}`)
  }

  return fetch(input, { ...init, headers })
}