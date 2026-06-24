/**
 * /api/shopify/install
 *
 * Initiates the Shopify OAuth flow.
 *
 * Can be called two ways:
 * 1. By the merchant manually from Settings → "Add a store" form
 *    (requires user to be logged in to CatalogStudio first)
 * 2. By /api/shopify/auth when the store is not yet installed
 *    (no Supabase session required — Shopify is sending the merchant to us)
 *
 * In case 2, after OAuth completes the callback will still need a user to
 * attach the store to. If no user session exists, callback redirects to login.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import crypto from 'crypto'

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const shop = searchParams.get('shop')
  const host = searchParams.get('host') // optional — passed through for App Bridge

  if (!shop) {
    return NextResponse.redirect(
      new URL('/dashboard/settings?error=missing_shop', request.url)
    )
  }

  // Validate shop domain format
  const shopRegex = /^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$/
  if (!shopRegex.test(shop)) {
    return NextResponse.redirect(
      new URL('/dashboard/settings?error=invalid_shop', request.url)
    )
  }

  // Check if user is logged in (optional — they may not be for first install)
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  // Generate CSRF nonce
  const nonce = crypto.randomBytes(16).toString('hex')

  const authUrl = new URL(`https://${shop}/admin/oauth/authorize`)
  authUrl.searchParams.set('client_id', process.env.SHOPIFY_CLIENT_ID!)
  authUrl.searchParams.set('scope', process.env.SHOPIFY_SCOPES!)
  authUrl.searchParams.set(
    'redirect_uri',
    `${process.env.NEXT_PUBLIC_APP_URL}/api/shopify/callback`
  )
  authUrl.searchParams.set('state', nonce)
  // grant_options[] MUST be appended as a raw string — URLSearchParams encodes
  // the brackets to %5B%5D which Shopify does not recognise, so it silently
  // falls back to issuing the old non-expiring token (causing the 403).
  const finalAuthUrl = authUrl.toString() + '&grant_options[]=offline'

  const response = NextResponse.redirect(finalAuthUrl)

  // Store nonce for CSRF check in callback
  response.cookies.set('shopify_oauth_nonce', nonce, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 600,
    path: '/',
  })

  // Store user_id if available (manual connect from Settings)
  if (user) {
    response.cookies.set('shopify_oauth_user', user.id, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 600,
      path: '/',
    })
  }

  // Store shop domain so callback can use it even without a user session
  response.cookies.set('shopify_oauth_shop', shop, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 600,
    path: '/',
  })

  return response
}