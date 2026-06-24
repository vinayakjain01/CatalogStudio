/**
 * Root page — handles two cases:
 *
 * 1. Shopify embedded app launch:
 *    Shopify loads /?shop=...&hmac=...&host=...&embedded=1&id_token=...&... inside
 *    the admin iframe. We forward the request to /api/shopify/auth for HMAC
 *    validation + sign-in.
 *
 *    CRITICAL: every query parameter Shopify sent must be forwarded UNCHANGED.
 *    Shopify computes the `hmac` over the full set of params (shop, host,
 *    embedded, id_token, locale, session, timestamp, ...). If we drop any of
 *    them, the HMAC recomputed in /api/shopify/auth can never match and the app
 *    shows "Unauthorized". So we copy the entire search string verbatim.
 *
 * 2. Direct visit (no Shopify params):
 *    Redirect to /login as before.
 */

import { redirect } from 'next/navigation'

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams

  const shop = typeof params.shop === 'string' ? params.shop : undefined
  const hmac = typeof params.hmac === 'string' ? params.hmac : undefined

  // Shopify embedded app launch — forward ALL params to the auth handler.
  if (shop && hmac) {
    const forwarded = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue
      if (Array.isArray(value)) {
        value.forEach((v) => forwarded.append(key, v))
      } else {
        forwarded.set(key, value)
      }
    }
    redirect(`/api/shopify/auth?${forwarded.toString()}`)
  }

  // Normal direct visit
  redirect('/login')
}