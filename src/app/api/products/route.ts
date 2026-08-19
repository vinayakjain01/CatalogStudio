/**
 * GET /api/products
 *
 * Lightweight product list for the editor's live-preview dropdown — returns
 * only the fields the canvas needs to render a real preview.
 *
 * Auth:    Supabase session cookie; storeId must belong to the signed-in user.
 * Query:   storeId (required), q (optional title search), limit (optional,
 *          default 50, capped at 100)
 * Returns: { products: [{ id, title, price, compare_at_price, vendor,
 *          product_type, imageUrl }] } — active products only, imageUrl
 *          resolved from the primary image (or first image) if any.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const storeId = request.nextUrl.searchParams.get('storeId')
  const q = request.nextUrl.searchParams.get('q')?.trim()
  const limit = Math.min(parseInt(request.nextUrl.searchParams.get('limit') || '50', 10), 100)
  if (!storeId) return NextResponse.json({ error: 'storeId required' }, { status: 400 })

  // ownership check
  const { data: store } = await supabase
    .from('stores').select('id').eq('id', storeId).eq('user_id', user.id).single()
  if (!store) return NextResponse.json({ error: 'Store not found' }, { status: 404 })

  let query = supabase
    .from('products')
    .select('id, title, price, compare_at_price, vendor, product_type, product_images(src, is_primary)')
    .eq('store_id', storeId)
    .eq('status', 'active')
    .order('title')
    .limit(limit)

  if (q) query = query.ilike('title', `%${q}%`)

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const products = (data || []).map((p: any) => {
    const img = p.product_images?.find((i: any) => i.is_primary) || p.product_images?.[0]
    return {
      id: p.id,
      title: p.title,
      price: p.price,
      compare_at_price: p.compare_at_price,
      vendor: p.vendor,
      product_type: p.product_type,
      imageUrl: img?.src ?? null,
    }
  })

  return NextResponse.json({ products })
}