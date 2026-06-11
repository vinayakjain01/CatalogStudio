import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import crypto from 'crypto'

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  const { searchParams } = new URL(request.url)
  const shop = searchParams.get('shop')

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

  // Generate nonce for CSRF protection
  const nonce = crypto.randomBytes(16).toString('hex')

  const authUrl = new URL(`https://${shop}/admin/oauth/authorize`)
  authUrl.searchParams.set('client_id', process.env.SHOPIFY_CLIENT_ID!)
  authUrl.searchParams.set('scope', process.env.SHOPIFY_SCOPES!)
  authUrl.searchParams.set('redirect_uri', `${process.env.NEXT_PUBLIC_APP_URL}/api/shopify/callback`)
  authUrl.searchParams.set('state', nonce)

  const response = NextResponse.redirect(authUrl.toString())

  // Store nonce + user_id in cookie (expires in 10 min)
  response.cookies.set('shopify_oauth_nonce', nonce, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 600,
    path: '/',
  })

  // Also store user_id so callback knows who is installing
  response.cookies.set('shopify_oauth_user', user.id, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 600,
    path: '/',
  })

  return response
}