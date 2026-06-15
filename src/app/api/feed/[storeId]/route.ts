import { NextRequest, NextResponse } from 'next/server'
import { createClient as createSupabaseAdmin } from '@supabase/supabase-js'

// Meta PRIMARY catalog feed (full product data) in Google-Shopping RSS 2.0 XML.
// The user creates a brand-new catalog in Commerce Manager → Data Sources →
// "Use a URL" → paste this link. Meta builds the whole catalog from it; each
// item's image is the generated creative (falling back to the original photo).
//
//   GET /api/meta/feed/[storeId]?token=FEED_TOKEN
//
// Returns application/xml. Streamed + paginated for large catalogs.

export const dynamic = 'force-dynamic'
export const maxDuration = 60

function getAdminClient() {
  return createSupabaseAdmin(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

// XML-escape text content
function xml(v: unknown): string {
  if (v === null || v === undefined) return ''
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
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
    .select('id, feed_token, currency, shop_domain, shop_name')
    .eq('id', storeId)
    .single()

  if (!store) return NextResponse.json({ error: 'Store not found' }, { status: 404 })
  if (!token || token !== store.feed_token) {
    return NextResponse.json({ error: 'Invalid or missing token' }, { status: 401 })
  }

  const currency = store.currency || 'USD'
  const domain = store.shop_domain || ''
  const PAGE = 1000
  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      // RSS 2.0 header with the Google Shopping namespace (Meta-compatible).
      controller.enqueue(encoder.encode(
        `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">\n` +
        `<channel>\n` +
        `<title>${xml(store.shop_name || 'Catalog')}</title>\n` +
        `<link>https://${xml(domain)}</link>\n` +
        `<description>Product catalog with generated creatives</description>\n`
      ))

      let from = 0
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { data: products, error } = await supabase
          .from('products')
          .select(`
            shopify_id, title, handle, vendor, product_type, tags,
            price, compare_at_price, inventory_quantity, status,
            product_images(src, is_primary),
            generated_images(generated_url, status, creative_type, updated_at)
          `)
          .eq('store_id', storeId)
          .eq('status', 'active')
          .range(from, from + PAGE - 1)

        if (error || !products || products.length === 0) break

        for (const p of products as any[]) {
          // Newest completed creative becomes the item image.
          const completed = (p.generated_images || [])
            .filter((g: any) => g.status === 'completed' && g.generated_url)
            .sort((a: any, b: any) =>
              new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())

          const original =
            p.product_images?.find((i: any) => i.is_primary)?.src ||
            p.product_images?.[0]?.src || ''

          const imageLink = completed[0]?.generated_url || original
          if (!imageLink) continue // Meta requires a non-empty image_link

          const additionalImages = completed.slice(1, 11).map((g: any) => g.generated_url)

          const hasSale = p.compare_at_price && p.compare_at_price > p.price
          const basePrice = hasSale ? p.compare_at_price : p.price
          const availability =
            (p.inventory_quantity ?? 0) > 0 ? 'in stock' : 'out of stock'
          const productLink = p.handle
            ? `https://${domain}/products/${p.handle}`
            : `https://${domain}`

          let item =
            `<item>\n` +
            `  <g:id>${xml(p.shopify_id)}</g:id>\n` +
            `  <g:title>${xml(p.title)}</g:title>\n` +
            `  <g:description>${xml(p.title)}</g:description>\n` +
            `  <g:link>${xml(productLink)}</g:link>\n` +
            `  <g:image_link>${xml(imageLink)}</g:image_link>\n` +
            `  <g:availability>${availability}</g:availability>\n` +
            `  <g:condition>new</g:condition>\n` +
            `  <g:price>${xml(`${basePrice} ${currency}`)}</g:price>\n`

          if (hasSale) {
            item += `  <g:sale_price>${xml(`${p.price} ${currency}`)}</g:sale_price>\n`
          }
          if (p.vendor) item += `  <g:brand>${xml(p.vendor)}</g:brand>\n`
          if (p.product_type) item += `  <g:product_type>${xml(p.product_type)}</g:product_type>\n`
          for (const img of additionalImages) {
            item += `  <g:additional_image_link>${xml(img)}</g:additional_image_link>\n`
          }
          item += `</item>\n`

          controller.enqueue(encoder.encode(item))
        }

        if (products.length < PAGE) break
        from += PAGE
      }

      controller.enqueue(encoder.encode(`</channel>\n</rss>\n`))

      // Best-effort sync stamp.
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
      'Content-Type': 'application/xml; charset=utf-8',
      'Content-Disposition': `inline; filename="catalog_${storeId}.xml"`,
      'Cache-Control': 'no-store',
    },
  })
}