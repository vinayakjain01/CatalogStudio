/**
 * GET /api/products/:id
 *
 * Product detail with variants and images, for the product detail page/panel.
 *
 * Auth:    Supabase session cookie (supabase.auth.getUser()); the product's
 *          store must belong to the signed-in user.
 * Returns: { product } — product row with product_variants[], product_images[],
 *          and generated_creatives[] embedded, sorted by position.
 *
 * Session-scoped: the ownership check joins through stores, and RLS enforces the
 * same thing at the database, so a product from another tenant is unreachable
 * even if this check were bypassed — a wrong-tenant id returns 404 (not 403)
 * so it can't be distinguished from a nonexistent one.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ productId: string }> }
) {
  const { productId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: product, error } = await supabase
    .from('products')
    .select(`
      id, shopify_id, title, handle, vendor, product_type, tags, status, description,
      price, compare_at_price, updated_at,
      stores!inner(id, user_id, shop_name, shop_domain, currency),
      product_variants(
        id, shopify_variant_id, title, sku, barcode, price, compare_at_price,
        inventory_quantity, inventory_policy, is_sold_out,
        option1, option2, option3, position
      ),
      product_images(id, shopify_image_id, src, cloudinary_url, alt, width, height, position, is_primary, variant_ids),
      generated_creatives(id, url, variant_id, template_id, width, height, created_at)
    `)
    .eq('id', productId)
    .single()

  if (error || !product) {
    return NextResponse.json({ error: 'Product not found' }, { status: 404 })
  }
  if ((product as any).stores?.user_id !== user.id) {
    // 404 rather than 403 — a wrong-tenant id should not confirm the row exists.
    return NextResponse.json({ error: 'Product not found' }, { status: 404 })
  }

  const variants = [...((product as any).product_variants ?? [])]
    .sort((a: any, b: any) => (a.position ?? 0) - (b.position ?? 0))
  const images = [...((product as any).product_images ?? [])]
    .sort((a: any, b: any) => (a.position ?? 0) - (b.position ?? 0))

  return NextResponse.json({
    product: { ...product, product_variants: variants, product_images: images },
  })
}
