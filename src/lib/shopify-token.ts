/**
 * Shopify token exchange.
 *
 * Shopify no longer accepts non-expiring offline access tokens for the Admin API
 * (you'll see: "[API] Non-expiring access tokens are no longer accepted ...").
 * The supported way to get an *expiring* offline token is OAuth token exchange:
 * trade the short-lived session token (`id_token`) that App Bridge / the embedded
 * launch gives us for a fresh offline access token.
 *
 * Docs: https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/token-exchange
 */

export interface OfflineTokenResult {
  access_token: string
  scope: string
  expires_in?: number
}

const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange'
const ID_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id_token'
const OFFLINE_TOKEN_TYPE =
  'urn:shopify:params:oauth:token-type:offline-access-token'

/**
 * Exchange a Shopify session token (id_token) for an expiring offline access
 * token for the given shop. Throws on failure with the Shopify response body.
 */
export async function exchangeSessionTokenForOfflineToken(
  shop: string,
  idToken: string
): Promise<OfflineTokenResult> {
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.SHOPIFY_CLIENT_ID,
      client_secret: process.env.SHOPIFY_CLIENT_SECRET,
      grant_type: TOKEN_EXCHANGE_GRANT,
      subject_token: idToken,
      subject_token_type: ID_TOKEN_TYPE,
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
    scope: data.scope ?? '',
    expires_in: data.expires_in,
  }
}