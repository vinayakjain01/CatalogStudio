import { NextRequest, NextResponse } from 'next/server'
import { createClient as createSupabaseAdmin } from '@supabase/supabase-js'
import crypto from 'crypto'

function getAdminClient() {
  return createSupabaseAdmin(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

function verifyShopifyHmac(query: URLSearchParams, secret: string): boolean {
  const hmac = query.get('hmac')
  if (!hmac) return false

  // Build the message: all params except hmac, sorted, joined as key=value&...
  const params: string[] = []
  query.forEach((value, key) => {
    if (key !== 'hmac') {
      params.push(`${key}=${value}`)
    }
  })
  params.sort()
  const message = params.join('&')

  const digest = crypto
    .createHmac('sha256', secret)
    .update(message)
    .digest('hex')

  // Timing-safe comparison
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac))
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)

  const code = searchParams.get('code')
  const shop = searchParams.get('shop')
  const state = searchParams.get('state')
  const hmac = searchParams.get('hmac')

  // --- Validate everything ---

  if (!code || !shop || !state || !hmac) {
    return NextResponse.redirect(
      new URL('/dashboard/settings?error=missing_params', request.url)
    )
  }

  // 1. Verify HMAC signature from Shopify
  const isValid = verifyShopifyHmac(searchParams, process.env.SHOPIFY_CLIENT_SECRET!)
  if (!isValid) {
    return NextResponse.redirect(
      new URL('/dashboard/settings?error=invalid_hmac', request.url)
    )
  }

  // 2. Verify nonce matches cookie
  const nonce = request.cookies.get('shopify_oauth_nonce')?.value
  if (!nonce || nonce !== state) {
    return NextResponse.redirect(
      new URL('/dashboard/settings?error=invalid_state', request.url)
    )
  }

  // 3. Get user_id from cookie
  const userId = request.cookies.get('shopify_oauth_user')?.value
  if (!userId) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  // --- Exchange code for permanent access token ---
  let accessToken: string
  let scope: string

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
  } catch (err: any) {
    console.error('Token exchange error:', err)
    return NextResponse.redirect(
      new URL('/dashboard/settings?error=token_exchange_failed', request.url)
    )
  }

  // --- Fetch shop info ---
  let shopInfo: { name: string; email: string; currency: string }

  try {
    const shopRes = await fetch(`https://${shop}/admin/api/2024-01/shop.json`, {
      headers: { 'X-Shopify-Access-Token': accessToken },
    })
    const shopData = await shopRes.json()
    shopInfo = {
      name: shopData.shop.name,
      email: shopData.shop.email,
      currency: shopData.shop.currency,
    }
  } catch {
    shopInfo = { name: shop, email: '', currency: 'INR' }
  }

  // --- Save store in Supabase ---
  const supabase = getAdminClient()

  const { data: store, error: storeError } = await supabase
    .from('stores')
    .upsert(
      {
        user_id: userId,
        shop_domain: shop,
        access_token: accessToken,
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
  console.error('Store save error:', JSON.stringify(storeError, null, 2))

  return NextResponse.redirect(
    new URL('/dashboard/settings?error=store_save_failed', request.url)
  )
}

  // --- Trigger first product sync in background ---
  // Fire-and-forget — don't await so redirect is instant
  fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/stores/${store.id}/sync`, {
    method: 'POST',
    headers: {
      'x-internal-secret': process.env.CRON_SECRET!,
    },
  }).catch(console.error)

  // Clear cookies and redirect
  const response = NextResponse.redirect(
    new URL('/dashboard/settings?success=store_connected', request.url)
  )
  response.cookies.delete('shopify_oauth_nonce')
  response.cookies.delete('shopify_oauth_user')

  return response
}