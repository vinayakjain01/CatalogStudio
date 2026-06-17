import { NextRequest, NextResponse } from 'next/server'
import { verifyShopifyWebhook } from '@/lib/shopify-webhook'
import { createClient as createSupabaseAdmin } from '@supabase/supabase-js'

export const runtime = 'nodejs'

// GDPR: 48 hours after a shop uninstalls, Shopify asks us to erase that shop's
// data. We delete the store row; products, generated_images, templates, rules,
// and categories cascade via their store_id foreign keys (ON DELETE CASCADE).
export async function POST(request: NextRequest) {
  const rawBody = await request.text()
  const hmac = request.headers.get('x-shopify-hmac-sha256')

  if (!verifyShopifyWebhook(rawBody, hmac)) {
    return new NextResponse('Unauthorized', { status: 401 })
  }

  let shopDomain: string | undefined
  try {
    shopDomain = JSON.parse(rawBody)?.shop_domain
  } catch {
    return new NextResponse('Bad payload', { status: 400 })
  }

  if (shopDomain) {
    const admin = createSupabaseAdmin(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
    // Deleting the store cascades to all store-scoped data.
    await admin.from('stores').delete().eq('shop_domain', shopDomain)
  }

  return new NextResponse('OK', { status: 200 })
}