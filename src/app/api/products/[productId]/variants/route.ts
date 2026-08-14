/**
 * GET /api/products/:id/variants — every variant for a product.
 *
 * Separate from the detail endpoint so a variant picker can refresh stock and
 * prices without refetching images and creatives alongside them.
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

  // Ownership is proven via the product's store before any variant is returned.
  const { data: product } = await supabase
    .from('products')
    .select('id, stores!inner(user_id)')
    .eq('id', productId)
    .single()

  if (!product || (product as any).stores?.user_id !== user.id) {
    return NextResponse.json({ error: 'Product not found' }, { status: 404 })
  }

  const { data: variants, error } = await supabase
    .from('product_variants')
    .select(`
      id, shopify_variant_id, title, sku, barcode, price, compare_at_price,
      inventory_quantity, inventory_policy, is_sold_out,
      option1, option2, option3, position, weight, weight_unit
    `)
    .eq('product_id', productId)
    .order('position', { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ variants: variants ?? [], count: variants?.length ?? 0 })
}
