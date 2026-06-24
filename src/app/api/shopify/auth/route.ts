/**
 * /api/shopify/auth
 *
 * Embedded app launch handler.
 *
 * When Shopify Admin opens the app it loads:
 *   https://yourapp.com/api/shopify/auth?shop=store.myshopify.com&hmac=...&host=...
 *
 * Flow:
 * 1. Validate HMAC — confirms the request is genuinely from Shopify
 * 2. Look up the store in Supabase by shop_domain
 *    - Not found → send through the normal OAuth install flow
 *    - Found → use Supabase Admin API to create a short-lived session token
 *      for the store owner, then redirect to /dashboard with the session set
 * 3. Set active_store_id cookie so the dashboard opens on the right store
 *
 * The merchant never sees a login form. The app loads instantly.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient as createAdmin } from '@supabase/supabase-js'
import crypto from 'crypto'

function adminClient() {
  return createAdmin(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

/**
 * The public origin this app is served from.
 *
 * We do NOT trust NEXT_PUBLIC_APP_URL blindly: if it is unset or still points
 * at http://localhost:3000 (a very common Vercel misconfiguration), the magic
 * link would redirect the embedded iframe to localhost and the merchant sees
 * "localhost refused to connect". Deriving the origin from the incoming request
 * is always correct because Shopify loads this route on the real app domain.
 */
function getAppOrigin(request: NextRequest): string {
  const env = process.env.NEXT_PUBLIC_APP_URL
  if (env && !env.includes('localhost') && !env.includes('127.0.0.1')) {
    return env.replace(/\/$/, '')
  }
  const forwardedHost = request.headers.get('x-forwarded-host')
  const host = forwardedHost ?? request.headers.get('host')
  const proto = request.headers.get('x-forwarded-proto') ?? 'https'
  if (host) return `${proto}://${host}`
  return request.nextUrl.origin
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

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const shop = searchParams.get('shop')
  const hmac = searchParams.get('hmac')
  const host = searchParams.get('host') ?? ''   // base64 host, used by App Bridge

  // Basic validation
  if (!shop || !hmac) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  const shopRegex = /^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$/
  if (!shopRegex.test(shop)) {
    return new NextResponse('Invalid shop domain', { status: 400 })
  }

  // Verify this request is genuinely from Shopify
  if (!verifyHmac(searchParams, process.env.SHOPIFY_CLIENT_SECRET!)) {
    console.error('[shopify/auth] HMAC invalid for shop:', shop)
    return new NextResponse('Unauthorized', { status: 401 })
  }

  const supabase = adminClient()

  // Look up the store
  const { data: store } = await supabase
    .from('stores')
    .select('id, user_id')
    .eq('shop_domain', shop)
    .maybeSingle()

  // Not installed yet — run OAuth install
  if (!store) {
    const installUrl = new URL('/api/shopify/install', request.url)
    installUrl.searchParams.set('shop', shop)
    return NextResponse.redirect(installUrl.toString())
  }

  // Get the owner's user record so we can create a session
  const { data: userData, error: userError } = await supabase.auth.admin.getUserById(store.user_id)
  if (userError || !userData?.user) {
    console.error('[shopify/auth] Cannot find user for store:', store.id, userError)
    return NextResponse.redirect(new URL('/login', request.url))
  }

  // Create a short-lived magic link so the user is signed into Supabase
  // without ever seeing a login form. The magic link redirects to our
  // /api/shopify/auth/finalize which sets the active store cookie and
  // then goes to /dashboard.
  const redirectTo = `${getAppOrigin(request)}/api/shopify/auth/finalize?store_id=${store.id}&host=${encodeURIComponent(host)}`

  const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
    type: 'magiclink',
    email: userData.user.email!,
    options: { redirectTo },
  })

  if (linkError || !linkData?.properties?.action_link) {
    console.error('[shopify/auth] Failed to generate magic link:', linkError)
    // Graceful fallback — let them log in normally
    const loginUrl = new URL('/login', request.url)
    loginUrl.searchParams.set('next', `/dashboard?shop=${shop}`)
    return NextResponse.redirect(loginUrl.toString())
  }

  return NextResponse.redirect(linkData.properties.action_link)
}