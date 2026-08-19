/**
 * GET /api/shopify/auth/finalize
 *
 * Landing point after Supabase magic-link auth for embedded app launch.
 *
 * Auth:    None checked directly — Supabase's @supabase/ssr middleware has
 *          already validated the magic-link token (?code=/?token_hash=) and
 *          set the session cookies before this route runs.
 * Query:   store_id (sets the active-store cookie), shop, host, embedded
 *          (passed through to the redirect for App Bridge)
 * Returns: 302 redirect to /dashboard (with shop/host/embedded preserved)
 *
 * This route just:
 * 1. Sets the active_store_id cookie to the store from the URL param
 * 2. Redirects to /dashboard
 */

import { NextRequest, NextResponse } from 'next/server'
import { ACTIVE_STORE_COOKIE } from '@/lib/active-store'

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const storeId = searchParams.get('store_id')

  // Preserve the embedded-context params — App Bridge needs them on the
  // document URL or it cannot configure itself.
  const dashboardUrl = new URL('/dashboard', request.url)
  for (const key of ['shop', 'host', 'embedded'] as const) {
    const value = searchParams.get(key)
    if (value) dashboardUrl.searchParams.set(key, value)
  }
  const response = NextResponse.redirect(dashboardUrl)

  if (storeId) {
    response.cookies.set(ACTIVE_STORE_COOKIE, storeId, {
      httpOnly: false, // readable by client for store-switcher
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 30, // 30 days
      path: '/',
    })
  }

  return response
}