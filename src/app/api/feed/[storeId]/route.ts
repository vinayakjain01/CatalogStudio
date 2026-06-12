import { NextRequest, NextResponse } from 'next/server'
import { createClient as createSupabaseAdmin } from '@supabase/supabase-js'

function getAdminClient() {
  return createSupabaseAdmin(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ storeId: string }> }
) {
  const { storeId } = await params
  const format = request.nextUrl.searchParams.get('format') || 'json'

  const supabase = getAdminClient()

  // Verify store exists (feed is public-readable by design for Meta/Google ingestion,
  // but gated behind a per-store secret token for security)
  const token = request.nextUrl.searchParams.get('token')
  const { data: store } = await supabase
    .from('stores')
    .select('id, feed_token')
    .eq('id', storeId)
    .single()

  if (!store) return NextResponse.json({ error: 'Store not found' }, { status: 404 })
  if (!token || token !== store.feed_token) {
    return NextResponse.json({ error: 'Invalid or missing token' }, { status: 401 })
  }

  // Get all products with their primary image + latest generated creative
  const { data: products } = await supabase
    .from('products')
    .select(`
      id, shopify_id, title, handle, price, compare_at_price,
      product_images(src, is_primary),
      generated_images(generated_url, status, updated_at)
    `)
    .eq('store_id', storeId)
    .eq('status', 'active')

  const feed = (products || []).map((p: any) => {
    const originalImage = p.product_images?.find((i: any) => i.is_primary)?.src
      || p.product_images?.[0]?.src
      || null

    const completedGenerated = (p.generated_images || [])
      .filter((g: any) => g.status === 'completed')
      .sort((a: any, b: any) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())

    return {
      product_id: p.shopify_id,
      title: p.title,
      handle: p.handle,
      price: p.price,
      compare_at_price: p.compare_at_price,
      original_image: originalImage,
      generated_image: completedGenerated[0]?.generated_url || null,
      generated_image_updated_at: completedGenerated[0]?.updated_at || null,
    }
  })

  if (format === 'csv') {
    const headers = ['product_id', 'title', 'handle', 'price', 'compare_at_price', 'original_image', 'generated_image']
    const rows = feed.map(f => headers.map(h => {
      const val = (f as any)[h]
      const str = val === null || val === undefined ? '' : String(val)
      return `"${str.replace(/"/g, '""')}"`
    }).join(','))
    const csv = [headers.join(','), ...rows].join('\n')

    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="feed_${storeId}.csv"`,
      },
    })
  }

  return NextResponse.json({
    store_id: storeId,
    generated_at: new Date().toISOString(),
    product_count: feed.length,
    products: feed,
  })
}