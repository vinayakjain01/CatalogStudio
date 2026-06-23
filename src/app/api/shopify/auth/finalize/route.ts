/**
 * /api/shopify/auth/finalize
 *
 * Landing point after Supabase magic-link auth for embedded app launch.
 *
 * Supabase has already validated the magic link token and set auth cookies.
 * This route just:
 * 1. Sets the active_store_id cookie to the store from the URL param
 * 2. Redirects to /dashboard
 *
 * The ?code= and ?token_hash= params from Supabase are handled automatically
 * by @supabase/ssr middleware before this route runs.
 */

import { NextRequest, NextResponse } from 'next/server'
import { ACTIVE_STORE_COOKIE } from '@/lib/active-store'

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const storeId = searchParams.get('store_id')

  const response = NextResponse.redirect(new URL('/dashboard', request.url))

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