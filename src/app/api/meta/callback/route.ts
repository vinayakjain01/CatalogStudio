import { NextRequest, NextResponse } from 'next/server'
import { createClient as createSupabaseAdmin } from '@supabase/supabase-js'

function getAdminClient() {
  return createSupabaseAdmin(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

/**
 * Meta OAuth callback: validates state, exchanges the code for an access token,
 * and stores the connection. Business/catalog selection is a follow-up — the
 * row is created in 'connected' state with the token so it can be enriched.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const code = searchParams.get('code')
  const state = searchParams.get('state')

  const nonce = request.cookies.get('meta_oauth_nonce')?.value
  const userId = request.cookies.get('meta_oauth_user')?.value
  const storeId = request.cookies.get('meta_oauth_store')?.value || null

  if (!code || !state || !nonce || state !== nonce || !userId) {
    return NextResponse.redirect(new URL('/dashboard/settings?error=meta_invalid_state', request.url))
  }

  let accessToken: string
  let expiresIn: number | null = null
  try {
    const tokenUrl = new URL('https://graph.facebook.com/v19.0/oauth/access_token')
    tokenUrl.searchParams.set('client_id', process.env.META_APP_ID!)
    tokenUrl.searchParams.set('client_secret', process.env.META_APP_SECRET!)
    tokenUrl.searchParams.set('redirect_uri', `${process.env.NEXT_PUBLIC_APP_URL}/api/meta/callback`)
    tokenUrl.searchParams.set('code', code)

    const res = await fetch(tokenUrl.toString())
    if (!res.ok) throw new Error(`Token exchange failed: ${res.status}`)
    const data = await res.json()
    accessToken = data.access_token
    expiresIn = data.expires_in ?? null
  } catch (err) {
    console.error('Meta token exchange error:', err)
    return NextResponse.redirect(new URL('/dashboard/settings?error=meta_token_failed', request.url))
  }

  // Identify the Meta user for reference.
  let metaUserId: string | null = null
  try {
    const meRes = await fetch(`https://graph.facebook.com/v19.0/me?access_token=${accessToken}`)
    if (meRes.ok) metaUserId = (await meRes.json()).id ?? null
  } catch {
    // non-fatal
  }

  const supabase = getAdminClient()
  const { error } = await supabase.from('meta_connections').insert({
    user_id: userId,
    store_id: storeId,
    meta_user_id: metaUserId,
    access_token: accessToken,
    token_expires_at: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
    status: 'connected',
  })

  if (error) {
    console.error('Meta connection save error:', error)
    return NextResponse.redirect(new URL('/dashboard/settings?error=meta_save_failed', request.url))
  }

  const response = NextResponse.redirect(
    new URL('/dashboard/settings?success=meta_connected', request.url)
  )
  response.cookies.delete('meta_oauth_nonce')
  response.cookies.delete('meta_oauth_user')
  response.cookies.delete('meta_oauth_store')
  return response
}
