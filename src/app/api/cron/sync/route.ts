import { NextRequest, NextResponse } from 'next/server'
import { createClient as createSupabaseAdmin } from '@supabase/supabase-js'
import { createShopifyClient } from '@/lib/shopify'

function getAdminClient() {
  return createSupabaseAdmin(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = getAdminClient()
  const { data: stores } = await supabase
    .from('stores')
    .select('*')
    .eq('is_active', true)

  if (!stores || stores.length === 0) {
    return NextResponse.json({ message: 'No active stores' })
  }

  const results = []

  for (const store of stores) {
    const { data: syncLog } = await supabase
      .from('sync_logs')
      .insert({ store_id: store.id, sync_type: 'cron', status: 'running' })
      .select()
      .single()

    try {
      const shopify = createShopifyClient(store.shop_domain, store.access_token)
      const products = await shopify.getProducts()
      let synced = 0

      for (const sp of products) {
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
              store_id: store.id,
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

        if (product && sp.images?.length > 0) {
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
        synced++
      }

      await supabase
        .from('stores')
        .update({ last_synced_at: new Date().toISOString() })
        .eq('id', store.id)

      await supabase
        .from('sync_logs')
        .update({
          status: 'completed',
          products_synced: synced,
          completed_at: new Date().toISOString(),
        })
        .eq('id', syncLog?.id)

      results.push({ store: store.shop_domain, synced })
    } catch (err: any) {
      await supabase
        .from('sync_logs')
        .update({
          status: 'failed',
          error_message: err.message,
          completed_at: new Date().toISOString(),
        })
        .eq('id', syncLog?.id)

      results.push({ store: store.shop_domain, error: err.message })
    }
  }

  return NextResponse.json({ results })
}