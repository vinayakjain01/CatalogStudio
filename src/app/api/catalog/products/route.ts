/**
 * GET /api/catalog/products?storeId=...&importId=...
 * Returns products for a line-sheet store (for SKU list used in Drive matching).
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getAdminClient } from '@/lib/generation-queue'

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const storeId  = request.nextUrl.searchParams.get('storeId')
  const importId = request.nextUrl.searchParams.get('importId')

  if (!storeId) return NextResponse.json({ error: 'storeId required' }, { status: 400 })

  // Verify store ownership
  const { data: store } = await supabase
    .from('stores').select('id').eq('id', storeId).eq('user_id', user.id).single()
  if (!store) return NextResponse.json({ error: 'Store not found' }, { status: 404 })

  const admin = getAdminClient()
  let query = admin.from('products')
    .select('id, sku, title, image_url, price')
    .eq('store_id', storeId)
    .order('title', { ascending: true })

  if (importId) {
    query = query.eq('import_id', importId)
  }

  const { data: products, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ products: products || [] })
}