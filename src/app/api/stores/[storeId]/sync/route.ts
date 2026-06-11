import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createSupabaseAdmin } from '@supabase/supabase-js'
import { createShopifyClient } from '@/lib/shopify'

function getAdminClient() {
  return createSupabaseAdmin(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

async function runSync(storeId: string, supabase: ReturnType<typeof getAdminClient>) {
  const { data: store, error: storeError } = await supabase
    .from('stores')
    .select('*')
    .eq('id', storeId)
    .single()

  if (storeError || !store) throw new Error('Store not found')

  const { data: syncLog } = await supabase
    .from('sync_logs')
    .insert({ store_id: storeId, sync_type: 'manual', status: 'running' })
    .select()
    .single()

  const shopify = createShopifyClient(store.shop_domain, store.access_token)
  const shopifyProducts = await shopify.getProducts()

  let syncedCount = 0

  for (const sp of shopifyProducts) {
    const primaryVariant = sp.variants[0]
    const price = primaryVariant ? parseFloat(primaryVariant.price) : 0
    const compareAtPrice = primaryVariant?.compare_at_price
      ? parseFloat(primaryVariant.compare_at_price)
      : null
    const tags = sp.tags
      ? sp.tags.split(',').map((t: string) => t.trim()).filter(Boolean)
      : []

    const { data: product } = await supabase
      .from('products')
      .upsert(
        {
          store_id: storeId,
          shopify_id: sp.id.toString(),
          title: sp.title,
          handle: sp.handle,
          vendor: sp.vendor || null,
          product_type: sp.product_type || null,
          tags,
          price,
          compare_at_price: compareAtPrice,
          inventory_quantity: primaryVariant?.inventory_quantity || 0,
          status: sp.status,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'store_id,shopify_id' }
      )
      .select()
      .single()

    if (!product) continue

    if (sp.images?.length > 0) {
      await supabase.from('product_images').delete().eq('product_id', product.id)
      await supabase.from('product_images').insert(
        sp.images.map((img: any, idx: number) => ({
          product_id: product.id,
          shopify_image_id: img.id.toString(),
          src: img.src,
          alt: img.alt || null,
          position: img.position || idx,
          is_primary: idx === 0,
        }))
      )
    }

    syncedCount++
  }

  await supabase
    .from('stores')
    .update({ last_synced_at: new Date().toISOString() })
    .eq('id', storeId)

  await supabase
    .from('sync_logs')
    .update({
      status: 'completed',
      products_synced: syncedCount,
      completed_at: new Date().toISOString(),
    })
    .eq('id', syncLog?.id)

  return syncedCount
}

// Called by the user from the UI (authenticated)
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ storeId: string }> }
) {
  const { storeId } = await params

  // Allow internal calls (from callback or cron) via secret header
  const internalSecret = request.headers.get('x-internal-secret')
  if (internalSecret === process.env.CRON_SECRET) {
    try {
      const supabase = getAdminClient()
      const synced = await runSync(storeId, supabase)
      return NextResponse.json({ success: true, productsSync: synced })
    } catch (err: any) {
      return NextResponse.json({ error: err.message }, { status: 500 })
    }
  }

  // Normal user-authenticated call
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Verify the store belongs to this user
  const { data: store } = await supabase
    .from('stores')
    .select('id')
    .eq('id', storeId)
    .eq('user_id', user.id)
    .single()

  if (!store) {
    return NextResponse.json({ error: 'Store not found' }, { status: 404 })
  }

  try {
    const adminSupabase = getAdminClient()
    const synced = await runSync(storeId, adminSupabase)
    return NextResponse.json({ success: true, productsSync: synced })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}