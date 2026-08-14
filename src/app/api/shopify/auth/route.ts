/**
 * /api/shopify/auth
 *
 * Embedded app launch handler.
 *
 * Flow:
 * 1. Validate HMAC.
 * 2. Look up the store. Not installed -> classic OAuth install.
 * 3. Token exchange: trade the launch `id_token` for an EXPIRING offline access
 *    token and store it. (Shopify rejects the old non-expiring tokens.)
 * 4. Sign the store owner into Supabase SERVER-SIDE (verifyOtp on a generated
 *    magic-link hash) and write the auth cookies as SameSite=None; Secure;
 *    Partitioned so they survive inside Shopify's admin iframe.
 * 5. Redirect straight to /dashboard. No client login form, no supabase.co hop.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient as createAdmin } from '@supabase/supabase-js'
import { createServerClient } from '@supabase/ssr'
import crypto from 'crypto'
import { ACTIVE_STORE_COOKIE } from '@/lib/active-store'
import { exchangeSessionTokenForOfflineToken } from '@/lib/shopify-token'

function adminClient() {
  return createAdmin(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

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

function verifyHmac(query: URLSearchParams, secret: string): boolean {
  const hmac = query.get('hmac')
  if (!hmac) return false

  const pairs: string[] = []
  query.forEach((value, key) => {
    if (key !== 'hmac') pairs.push(`${key}=${value}`)
  })
  pairs.sort()

  const digest = crypto
    .createHmac('sha256', secret)
    .update(pairs.join('&'))
    .digest('hex')

  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac))
  } catch {
    return false
  }
}

/**
 * Supabase server client that writes session cookies onto `response` with
 * SameSite=None so they're sent on requests inside the Shopify iframe.
 */
function sessionClient(request: NextRequest, response: NextResponse) {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, {
              ...options,
              sameSite: 'none',
              secure: true,
              partitioned: true,
              path: '/',
            })
          })
        },
      },
    }
  )
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const shop = searchParams.get('shop')
  const hmac = searchParams.get('hmac')
  const idToken = searchParams.get('id_token') ?? ''

  if (!shop || !hmac) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  const shopRegex = /^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$/
  if (!shopRegex.test(shop)) {
    return new NextResponse('Invalid shop domain', { status: 400 })
  }

  if (!verifyHmac(searchParams, process.env.SHOPIFY_CLIENT_SECRET!)) {
    console.error('[shopify/auth] HMAC invalid for shop:', shop)
    return new NextResponse('Unauthorized', { status: 401 })
  }

  const supabase = adminClient()

  const { data: store } = await supabase
    .from('stores')
    .select('id, user_id')
    .eq('shop_domain', shop)
    .maybeSingle()

  // Not installed yet — run OAuth install.
  if (!store) {
    const installUrl = new URL('/api/shopify/install', request.url)
    installUrl.searchParams.set('shop', shop)
    return NextResponse.redirect(installUrl.toString())
  }

  // --- 3. Token exchange: refresh to an expiring offline access token. ---
  //
  // Three things go wrong here if this block is careless, and all three did:
  //  1. needs_reauth was never cleared on success, so the "token expired"
  //     banner survived a perfectly good reconnect and could never clear.
  //  2. expires_in was discarded, leaving token_expires_at null — nothing could
  //     tell a fresh expiring token from a legacy non-expiring one.
  //  3. a failed exchange only reached a server log, so the app loaded normally
  //     with a dead token and the merchant had no idea why syncing failed.
  // Carries the reason a token refresh failed through to the dashboard, so the
  // merchant sees Shopify's actual message instead of it dying in a server log.
  let authError: string | null = null

  if (idToken) {
    try {
      const { access_token, scope, expires_in, refresh_token, refresh_token_expires_in } =
        await exchangeSessionTokenForOfflineToken(shop, idToken)

      await supabase
        .from('stores')
        .update({
          access_token,
          ...(scope ? { scope } : {}),
          needs_reauth: false,
          token_expires_at: expires_in
            ? new Date(Date.now() + expires_in * 1000).toISOString()
            : null,
          // Keeps background jobs authenticated past the 1-hour access token.
          ...(refresh_token ? { refresh_token } : {}),
          ...(refresh_token_expires_in
            ? {
                refresh_token_expires_at: new Date(
                  Date.now() + refresh_token_expires_in * 1000
                ).toISOString(),
              }
            : {}),
        })
        .eq('id', store.id)

      console.log(
        `[shopify/auth] token exchange OK shop=${shop} prefix=${access_token.slice(0, 6)} expires_in=${expires_in ?? 'none'}`
      )
    } catch (err: any) {
      // Flag the store so the UI keeps prompting a reconnect rather than
      // silently serving a token the Admin API will reject.
      authError = String(err?.message || err).slice(0, 300)
      console.error('[shopify/auth] token exchange failed:', authError)
      await supabase
        .from('stores')
        .update({ needs_reauth: true })
        .eq('id', store.id)
    }
  } else {
    // No id_token means this was not an embedded launch, so no refresh was even
    // attempted — worth saying out loud, because the symptom (stale token) is
    // identical to a failed exchange.
    authError = 'no_id_token'
  }

  // --- 4. Sign the owner into Supabase, server-side. ---
  const { data: userData, error: userError } =
    await supabase.auth.admin.getUserById(store.user_id)
  if (userError || !userData?.user?.email) {
    console.error('[shopify/auth] Cannot find user for store:', store.id, userError)
    return NextResponse.redirect(new URL('/login', request.url))
  }

  const { data: linkData, error: linkError } =
    await supabase.auth.admin.generateLink({
      type: 'magiclink',
      email: userData.user.email,
    })

  const tokenHash = linkData?.properties?.hashed_token

  // Build the response we'll attach cookies to, then redirect to /dashboard.
  const dashboardUrl = new URL('/dashboard', getAppOrigin(request))
  if (authError) dashboardUrl.searchParams.set('auth_error', authError)
  const response = NextResponse.redirect(dashboardUrl)
  response.cookies.set(ACTIVE_STORE_COOKIE, store.id, {
    httpOnly: false,
    secure: true,
    sameSite: 'none',
    partitioned: true,
    maxAge: 60 * 60 * 24 * 30,
    path: '/',
  })

  if (linkError || !tokenHash) {
    console.error('[shopify/auth] generateLink failed:', linkError)
    return NextResponse.redirect(new URL('/login', request.url))
  }

  const session = sessionClient(request, response)
  // generateLink('magiclink') hashes can verify as either type depending on
  // project config; try both before giving up.
  let verified = false
  for (const type of ['email', 'magiclink'] as const) {
    const { error } = await session.auth.verifyOtp({ token_hash: tokenHash, type })
    if (!error) {
      verified = true
      break
    }
  }

  if (!verified) {
    console.error('[shopify/auth] verifyOtp failed for store:', store.id)
    return NextResponse.redirect(new URL('/login', request.url))
  }

  return response
}