/**
 * Root page — handles two cases:
 *
 * 1. Shopify embedded app launch:
 *    Shopify loads /?shop=...&hmac=...&host=... inside the admin iframe.
 *    We immediately forward to /api/shopify/auth which validates and signs in.
 *
 * 2. Direct visit (no Shopify params):
 *    Redirect to /login as before.
 */

import { redirect } from 'next/navigation'

interface SearchParams {
  shop?: string
  hmac?: string
  host?: string
  session?: string
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const params = await searchParams
  const { shop, hmac, host, session } = params

  // Shopify embedded app launch — forward all params to the auth handler
  if (shop && hmac) {
    const authUrl = new URL('/api/shopify/auth', process.env.NEXT_PUBLIC_APP_URL!)
    authUrl.searchParams.set('shop', shop)
    authUrl.searchParams.set('hmac', hmac)
    if (host) authUrl.searchParams.set('host', host)
    if (session) authUrl.searchParams.set('session', session)
    redirect(authUrl.pathname + authUrl.search)
  }

  // Normal direct visit
  redirect('/login')
}