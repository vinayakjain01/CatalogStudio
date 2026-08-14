/**
 * GET /api/feed/{storeId}?token={feed_token}&format={csv|xml|json}
 *
 * The public Meta Commerce Manager feed. Paste the URL into
 * Commerce Manager → Data Sources → "Use a URL" and Meta builds the catalog
 * from it; each item's image is the generated creative, falling back to the
 * original product photo so a row is never dropped for lack of an image.
 *
 * v2 — ONE ROW PER VARIANT. It previously emitted one row per product using the
 * flattened variant[0] price and stock, so a product's other sizes/colours were
 * invisible to Meta and a sold-out variant could still advertise as in stock.
 * Rows are now keyed {store}_{product}_{variant}, which is also what lets a
 * Meta ad deep-link to the exact variant.
 *
 * Auth is the store's feed_token, not a session — this endpoint is fetched by
 * Meta's crawler. The token grants read-only access to this feed and nothing
 * else, which is why it is safe to embed in the URL.
 *
 * Streamed and paginated: a 10k-variant catalog must not buffer in memory or
 * trip the function timeout.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient as createSupabaseAdmin } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

type FeedFormat = 'csv' | 'xml' | 'json'

/** Variants fetched per round trip. */
const PAGE = 500

function getAdminClient() {
  return createSupabaseAdmin(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

function xml(v: unknown): string {
  if (v === null || v === undefined) return ''
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** RFC 4180: quote always, double any embedded quote. Newlines survive intact. */
function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '""'
  return `"${String(v).replace(/"/g, '""')}"`
}

/** Meta rejects HTML in description; strip tags and collapse whitespace. */
function stripHtml(html: string | null | undefined): string {
  if (!html) return ''
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

const COLUMNS = [
  'id', 'title', 'description', 'availability', 'condition',
  'price', 'sale_price', 'link', 'image_link', 'additional_image_link',
  'brand', 'gtin', 'mpn',
  'custom_label_0', 'custom_label_1', 'custom_label_2',
] as const

type FeedRow = Record<(typeof COLUMNS)[number], string>

/**
 * Flatten one variant into the Meta column set.
 *
 * Meta's `price` is the reference (struck-through) price and `sale_price` the
 * current one — so on a discounted variant compare_at goes in price and the
 * actual price in sale_price. Emitting them the other way round makes every
 * discount display backwards.
 */
function buildRow(
  variant: any,
  product: any,
  storeId: string,
  currency: string,
  domain: string
): FeedRow | null {
  const creatives: any[] = product.generated_creatives ?? []

  // Creative for THIS variant wins; a product-level creative is the fallback.
  const forVariant = creatives
    .filter(c => c.url && (c.variant_id === variant.id || c.variant_id == null))
    .sort((a, b) => {
      const exact = Number(b.variant_id === variant.id) - Number(a.variant_id === variant.id)
      if (exact !== 0) return exact
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    })

  const images: any[] = product.product_images ?? []
  const variantImage = images.find(i => (i.variant_ids ?? []).includes(String(variant.shopify_variant_id)))
  const primaryImage = variantImage ?? images.find(i => i.is_primary) ?? images[0]
  const originalSrc: string = primaryImage?.cloudinary_url || primaryImage?.src || ''

  const imageLink = forVariant[0]?.url || originalSrc
  // Meta drops any item without an image_link, so skip rather than emit a broken row.
  if (!imageLink) return null

  // Additional images: remaining creatives, then the other product photos.
  const additional = [
    ...forVariant.slice(1).map(c => c.url),
    ...images.map(i => i.cloudinary_url || i.src).filter(src => src && src !== originalSrc),
  ].filter(Boolean).slice(0, 10)

  const price = Number(variant.price ?? 0)
  const compareAt = variant.compare_at_price == null ? null : Number(variant.compare_at_price)
  const onSale = compareAt !== null && compareAt > price

  const link = product.handle
    ? `https://${domain}/products/${product.handle}?variant=${variant.shopify_variant_id}`
    : `https://${domain}`

  const title = variant.title && variant.title !== 'Default Title'
    ? `${product.title} - ${variant.title}`
    : product.title

  return {
    id: `${storeId}_${product.shopify_id}_${variant.shopify_variant_id}`,
    title,
    // Meta requires a non-empty description; the title is a safe stand-in.
    description: stripHtml(product.description) || title,
    availability: variant.is_sold_out ? 'out of stock' : 'in stock',
    condition: 'new',
    price: `${(onSale ? compareAt : price).toFixed(2)} ${currency}`,
    sale_price: onSale ? `${price.toFixed(2)} ${currency}` : '',
    link,
    image_link: imageLink,
    additional_image_link: additional.join(','),
    brand: product.vendor || '',
    gtin: variant.barcode || '',
    mpn: variant.sku || '',
    custom_label_0: variant.is_sold_out ? 'sold_out' : 'in_stock',
    custom_label_1: product.product_type || '',
    custom_label_2: (product.tags ?? []).slice(0, 3).join(','),
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ storeId: string }> }
) {
  const { storeId } = await params
  const token = request.nextUrl.searchParams.get('token')
  const requested = (request.nextUrl.searchParams.get('format') || 'csv').toLowerCase()
  const format: FeedFormat = requested === 'xml' || requested === 'json' ? requested : 'csv'

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

  const currency = store.currency || 'INR'
  const domain = store.shop_domain || ''
  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      const write = (s: string) => controller.enqueue(encoder.encode(s))

      if (format === 'csv') write(COLUMNS.join(',') + '\n')
      if (format === 'json') write('[')
      if (format === 'xml') {
        write(
          `<?xml version="1.0" encoding="UTF-8"?>\n` +
          `<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">\n<channel>\n` +
          `<title>${xml(store.shop_name || 'Catalog')}</title>\n` +
          `<link>https://${xml(domain)}</link>\n` +
          `<description>Product catalog with generated creatives</description>\n`
        )
      }

      let emitted = 0
      let from = 0

      try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          // Driven from variants — the feed's unit of row — pulling the parent
          // product and its creatives alongside.
          const { data: variants, error } = await supabase
            .from('product_variants')
            .select(`
              id, shopify_variant_id, title, sku, barcode,
              price, compare_at_price, is_sold_out,
              products!inner (
                id, shopify_id, title, handle, vendor, product_type, tags, description, status,
                product_images ( src, cloudinary_url, is_primary, variant_ids, position ),
                generated_creatives ( url, variant_id, created_at )
              )
            `)
            .eq('store_id', storeId)
            .eq('products.status', 'active')
            .order('id', { ascending: true })
            .range(from, from + PAGE - 1)

          if (error) {
            console.error('[feed] query failed:', error.message)
            break
          }
          if (!variants || variants.length === 0) break

          for (const v of variants as any[]) {
            const row = buildRow(v, v.products, storeId, currency, domain)
            if (!row) continue

            if (format === 'csv') {
              write(COLUMNS.map(c => csvCell(row[c])).join(',') + '\n')
            } else if (format === 'json') {
              write((emitted > 0 ? ',' : '') + JSON.stringify(row))
            } else {
              let item = '<item>\n'
              for (const c of COLUMNS) {
                if (!row[c]) continue
                if (c === 'additional_image_link') {
                  for (const img of row[c].split(',').filter(Boolean)) {
                    item += `  <g:additional_image_link>${xml(img)}</g:additional_image_link>\n`
                  }
                  continue
                }
                item += `  <g:${c}>${xml(row[c])}</g:${c}>\n`
              }
              item += '</item>\n'
              write(item)
            }
            emitted++
          }

          if (variants.length < PAGE) break
          from += PAGE
        }
      } catch (err: any) {
        console.error('[feed] stream aborted:', err?.message)
      }

      if (format === 'json') write(']')
      if (format === 'xml') write('</channel>\n</rss>\n')

      // Best-effort freshness stamp — never block closing the stream on it.
      supabase
        .from('stores')
        .update({ meta_feed_last_sync: new Date().toISOString(), meta_feed_status: 'active' })
        .eq('id', storeId)
        .then(() => {})

      controller.close()
    },
  })

  const contentType =
    format === 'csv'  ? 'text/csv; charset=utf-8' :
    format === 'json' ? 'application/json; charset=utf-8' :
                        'application/xml; charset=utf-8'

  return new NextResponse(stream, {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `inline; filename="catalog_${storeId}.${format}"`,
      'Cache-Control': 'no-store',
    },
  })
}
