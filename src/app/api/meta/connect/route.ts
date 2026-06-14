import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import crypto from 'crypto'

// Begins Meta (Facebook) OAuth. Requires META_APP_ID / META_APP_SECRET and a
// configured redirect URI in the Meta app. Scopes cover Commerce/catalog work.
const META_SCOPES = ['catalog_management', 'business_management', 'ads_management']

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.redirect(new URL('/login', request.url))

  if (!process.env.META_APP_ID) {
    return NextResponse.redirect(
      new URL('/dashboard/settings?error=meta_not_configured', request.url)
    )
  }

  const storeId = request.nextUrl.searchParams.get('storeId') || ''
  const nonce = crypto.randomBytes(16).toString('hex')

  const authUrl = new URL('https://www.facebook.com/v19.0/dialog/oauth')
  authUrl.searchParams.set('client_id', process.env.META_APP_ID)
  authUrl.searchParams.set('redirect_uri', `${process.env.NEXT_PUBLIC_APP_URL}/api/meta/callback`)
  authUrl.searchParams.set('scope', META_SCOPES.join(','))
  authUrl.searchParams.set('state', nonce)
  authUrl.searchParams.set('response_type', 'code')

  const response = NextResponse.redirect(authUrl.toString())
  const cookieOpts = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    maxAge: 600,
    path: '/',
  }
  response.cookies.set('meta_oauth_nonce', nonce, cookieOpts)
  response.cookies.set('meta_oauth_user', user.id, cookieOpts)
  if (storeId) response.cookies.set('meta_oauth_store', storeId, cookieOpts)
  return response
}
