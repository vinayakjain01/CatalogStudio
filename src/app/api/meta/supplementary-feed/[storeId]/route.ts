import { NextRequest, NextResponse } from 'next/server'
import { createClient as createSupabaseAdmin } from '@supabase/supabase-js'

// Meta Supplementary Feed (image replacement).
// Docs: a supplementary feed overrides fields on items already in the catalog,
// matched by `id`. For creative replacement we override `image_link` with the
// generated creative URL. We keep the output to Meta's column spec.
//
//   GET /api/meta/supplementary-feed/[storeId]?token=FEED_TOKEN
//
// Returns text/csv. Meta is configured to pull this URL on a schedule.

export const dynamic = 'force-dynamic'
export const maxDuration = 60

function getAdminClient() {
  return createSupabaseAdmin(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  const s = String(v)
  // Escape if it contains comma, quote, or newline
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ storeId: string }> }
) {
  const { storeId } = await params
  const token = request.nextUrl.searchParams.get('token')

  const supabase = getAdminClient()

  const { data: store } = await supabase
    .from('stores')
    .select('id, feed_token, currency')
    .eq('id', storeId)
    .single()

  if (!store) return NextResponse.json({ error: 'Store not found' }, { status: 404 })
  if (!token || token !== store.feed_token) {
    return NextResponse.json({ error: 'Invalid or missing token' }, { status: 401 })
  }

  const currency = store.currency || 'USD'

  // Stream rows so a 10k-product catalog never buffers fully in memory.
  // Supabase has a 1000-row default cap, so we paginate in pages of 1000.
  const PAGE = 1000
  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      // Header — Meta supplementary feed columns. `id` + `image_link` are the
      // required pair for image replacement; the rest are optional overrides.
      const header = ['id', 'image_link', 'additional_image_link', 'title', 'price', 'sale_price']
      controller.enqueue(encoder.encode(header.join(',') + '\n'))

      let from = 0
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { data: products, error } = await supabase
          .from('products')
          .select(`
            shopify_id, title, price, compare_at_price,
            product_images(src, is_primary),
            generated_images(generated_url, status, creative_type, updated_at)
          `)
          .eq('store_id', storeId)
          .eq('status', 'active')
          .range(from, from + PAGE - 1)

        if (error || !products || products.length === 0) break

        for (const p of products as any[]) {
          // Pick the newest completed creative as the replacement image.
          const completed = (p.generated_images || [])
            .filter((g: any) => g.status === 'completed' && g.generated_url)
            .sort((a: any, b: any) =>
              new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())

          // No creative yet → fall back to the original product image so the
          // feed row is still valid (Meta requires image_link to be non-empty).
          const original =
            p.product_images?.find((i: any) => i.is_primary)?.src ||
            p.product_images?.[0]?.src || ''

          const imageLink = completed[0]?.generated_url || original
          if (!imageLink) continue // skip items with no usable image

          // additional_image_link = up to 10 other creatives (e.g. festival,
          // clearance variants), comma-free per Meta (use the | separator).
          const additional = completed.slice(1, 11)
            .map((g: any) => g.generated_url)
            .join(',')

          const hasSale = p.compare_at_price && p.compare_at_price > p.price
          const price = `${p.compare_at_price && hasSale ? p.compare_at_price : p.price} ${currency}`
          const salePrice = hasSale ? `${p.price} ${currency}` : ''

          const row = [
            csvCell(p.shopify_id),     // id — must match catalog item id
            csvCell(imageLink),        // image_link — the replacement
            csvCell(additional),       // additional_image_link
            csvCell(p.title),          // title (optional override)
            csvCell(price),            // price (optional override)
            csvCell(salePrice),        // sale_price (optional)
          ].join(',')

          controller.enqueue(encoder.encode(row + '\n'))
        }

        if (products.length < PAGE) break
        from += PAGE
      }

      // Best-effort: stamp last feed pull time (don't block the stream on it).
      supabase
        .from('stores')
        .update({ meta_feed_last_sync: new Date().toISOString(), meta_feed_status: 'active' })
        .eq('id', storeId)
        .then(() => {})

      controller.close()
    },
  })

  return new NextResponse(stream, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `inline; filename="meta_feed_${storeId}.csv"`,
      'Cache-Control': 'no-store',
    },
  })
}