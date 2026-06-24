/**
 * /api/shopify/callback
 *
 * Handles the OAuth callback from Shopify after the merchant approves access.
 *
 * Two scenarios:
 * A) Existing CatalogStudio user connecting a new store:
 *    - shopify_oauth_user cookie is set (user was logged in during install)
 *    - Saves store under that user_id → redirects to /dashboard/settings
 *
 * B) New merchant installing for the first time (via embedded app launch):
 *    - No shopify_oauth_user cookie
 *    - Creates a new Supabase user account using shop email from Shopify
 *    - Saves store → generates magic link → redirects to /dashboard
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient as createSupabaseAdmin } from '@supabase/supabase-js'
import crypto from 'crypto'
import { ACTIVE_STORE_COOKIE } from '@/lib/active-store'
import { createShopifyClient } from '@/lib/shopify'

function adminClient() {
  return createSupabaseAdmin(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

/** Public origin, ignoring a localhost NEXT_PUBLIC_APP_URL (see auth route). */
function getAppOrigin(request: NextRequest): string {
  const env = process.env.NEXT_PUBLIC_APP_URL
  if (env && !env.includes('localhost') && !env.includes('127.0.0.1')) {
    return env.replace(/\/$/, '')
  }
  const host =
    request.headers.get('x-forwarded-host') ?? request.headers.get('host')
  const proto = request.headers.get('x-forwarded-proto') ?? 'https'
  return host ? `${proto}://${host}` : request.nextUrl.origin
}

function verifyShopifyHmac(query: URLSearchParams, secret: string): boolean {
  const hmac = query.get('hmac')
  if (!hmac) return false

  const params: string[] = []
  query.forEach((value, key) => {
    if (key !== 'hmac') params.push(`${key}=${value}`)
  })
  params.sort()
  const message = params.join('&')

  const digest = crypto
    .createHmac('sha256', secret)
    .update(message)
    .digest('hex')

  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac))
  } catch {
    return false
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)

  const code = searchParams.get('code')
  const shop = searchParams.get('shop')
  const state = searchParams.get('state')
  const hmac = searchParams.get('hmac')

  if (!code || !shop || !state || !hmac) {
    return NextResponse.redirect(
      new URL('/dashboard/settings?error=missing_params', request.url)
    )
  }

  // 1. Verify HMAC
  if (!verifyShopifyHmac(searchParams, process.env.SHOPIFY_CLIENT_SECRET!)) {
    return NextResponse.redirect(
      new URL('/dashboard/settings?error=invalid_hmac', request.url)
    )
  }

  // 2. Verify CSRF nonce
  const nonce = request.cookies.get('shopify_oauth_nonce')?.value
  if (!nonce || nonce !== state) {
    return NextResponse.redirect(
      new URL('/dashboard/settings?error=invalid_state', request.url)
    )
  }

  // 3. Get user context from cookies
  const userId = request.cookies.get('shopify_oauth_user')?.value
  // userId may be null if this is a first-time embedded install

  // --- Exchange code for access token ---
  let accessToken: string
  let scope: string
  let expiresAt: string | null = null

  try {
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.SHOPIFY_CLIENT_ID,
        client_secret: process.env.SHOPIFY_CLIENT_SECRET,
        code,
      }),
    })

    if (!tokenRes.ok) {
      throw new Error(`Token exchange failed: ${tokenRes.status}`)
    }

    const tokenData = await tokenRes.json()
    accessToken = tokenData.access_token
    scope = tokenData.scope
    // Expiring offline tokens include expires_in (seconds). Store the absolute
    // expiry so we can re-auth before it lapses. Legacy permanent tokens omit it.
    if (tokenData.expires_in) {
      expiresAt = new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
    }
  } catch (err: any) {
    console.error('[callback] Token exchange error:', err)
    return NextResponse.redirect(
      new URL('/dashboard/settings?error=token_exchange_failed', request.url)
    )
  }

  // --- Fetch shop info from Shopify (GraphQL — REST /shop.json is deprecated) ---
  let shopInfo = { name: shop, email: '', currency: 'INR' }

  try {
    const shopData = await createShopifyClient(shop, accessToken).getShop()
    shopInfo = {
      name: shopData.name ?? shop,
      email: shopData.email ?? '',
      currency: shopData.currency ?? 'INR',
    }
  } catch (err) {
    console.warn('[callback] Failed to fetch shop info, using defaults')
  }

  const supabase = adminClient()

  // --- Resolve which user to attach this store to ---
  let resolvedUserId = userId

  if (!resolvedUserId) {
    // Scenario B: no logged-in user — find or create account from shop email
    if (!shopInfo.email) {
      // No email available — redirect to login so user can create account manually
      const loginUrl = new URL('/login', request.url)
      loginUrl.searchParams.set('error', 'no_email')
      loginUrl.searchParams.set('shop', shop)
      const response = NextResponse.redirect(loginUrl.toString())
      response.cookies.delete('shopify_oauth_nonce')
      response.cookies.delete('shopify_oauth_shop')
      return response
    }

    // Check if a user exists with this email
    const { data: existingUsers } = await supabase.auth.admin.listUsers()
    const existingUser = existingUsers?.users?.find(u => u.email === shopInfo.email)

    if (existingUser) {
      resolvedUserId = existingUser.id
    } else {
      // Create new Supabase account for this merchant
      const tempPassword = crypto.randomBytes(32).toString('hex')
      const { data: newUser, error: createError } = await supabase.auth.admin.createUser({
        email: shopInfo.email,
        password: tempPassword,
        email_confirm: true, // skip email confirmation
        user_metadata: {
          full_name: shopInfo.name,
          shopify_shop: shop,
        },
      })

      if (createError || !newUser?.user) {
        console.error('[callback] Failed to create user:', createError)
        return NextResponse.redirect(
          new URL('/dashboard/settings?error=user_create_failed', request.url)
        )
      }

      resolvedUserId = newUser.user.id
    }
  }

  // --- Save store in Supabase ---
  const { data: store, error: storeError } = await supabase
    .from('stores')
    .upsert(
      {
        user_id: resolvedUserId,
        shop_domain: shop,
        access_token: accessToken,
        token_expires_at: expiresAt,
        needs_reauth: false,
        scope,
        shop_name: shopInfo.name,
        shop_email: shopInfo.email,
        currency: shopInfo.currency,
        is_active: true,
        installed_at: new Date().toISOString(),
      },
      { onConflict: 'shop_domain' }
    )
    .select()
    .single()

  if (storeError || !store) {
    console.error('[callback] Store save error:', JSON.stringify(storeError, null, 2))
    return NextResponse.redirect(
      new URL('/dashboard/settings?error=store_save_failed', request.url)
    )
  }

  // --- Trigger first product sync (fire and forget) ---
  fetch(`${getAppOrigin(request)}/api/stores/${store.id}/sync`, {
    method: 'POST',
    headers: { 'x-internal-secret': process.env.CRON_SECRET! },
  }).catch(console.error)

  // Clear OAuth cookies
  const clearCookies = (res: NextResponse) => {
    res.cookies.delete('shopify_oauth_nonce')
    res.cookies.delete('shopify_oauth_user')
    res.cookies.delete('shopify_oauth_shop')
    return res
  }

  if (userId) {
    // Scenario A: existing user connecting store → go to settings
    const response = NextResponse.redirect(
      new URL('/dashboard/settings?success=store_connected', request.url)
    )
    clearCookies(response)
    response.cookies.set(ACTIVE_STORE_COOKIE, store.id, {
      httpOnly: false,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 30,
      path: '/',
    })
    return response
  }

  // Scenario B: new merchant — generate magic link to sign them in automatically
  const redirectTo = `${getAppOrigin(request)}/api/shopify/auth/finalize?store_id=${store.id}`

  const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
    type: 'magiclink',
    email: shopInfo.email,
    options: { redirectTo },
  })

  if (linkError || !linkData?.properties?.action_link) {
    console.error('[callback] Magic link failed:', linkError)
    // Fallback — user must log in manually
    const loginUrl = new URL('/login', request.url)
    loginUrl.searchParams.set('email', shopInfo.email)
    loginUrl.searchParams.set('hint', 'Check your email to sign in')
    const response = clearCookies(NextResponse.redirect(loginUrl.toString()))
    return response
  }

  const response = clearCookies(NextResponse.redirect(linkData.properties.action_link))
  return response
}