/**
 * The Shopify `host` parameter, remembered across page loads.
 *
 * App Bridge configures itself from `host` on the document URL. Any full load
 * without it — a refresh, a deep link, a redirect that drops query params —
 * fails with "missing required configuration fields: shop" and leaves
 * window.shopify undefined, which silently disables session tokens.
 *
 * Storing it lets the proxy re-attach it instead of the app half-working.
 */
export const SHOPIFY_HOST_COOKIE = 'shopify_host'
