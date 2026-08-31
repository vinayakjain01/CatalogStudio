/**
 * GET /api/creatives — generated creatives, paginated and filtered.
 *
 * Reads generated_creatives (v2), which carries store_id and variant_id, so a
 * tenant filter needs no join and one creative per variant is representable.
 * The legacy generated_images table has neither.
 *
 * Auth:    Supabase session cookie (supabase.auth.getUser()); storeId ownership
 *          re-checked explicitly (404s rather than returning an empty page)
 * Query:   storeId (required), templateId, productId, variantId, search,
 *          assetType ('catalog'|'feed'|'story'|'reel', defaults to 'catalog'),
 *          page (1-based), pageSize (max 100)
 * Returns: { creatives, page, pageSize, total, totalPages }
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { ALL_ASSET_TYPES, type AssetType } from '@/types/template'

export const dynamic = 'force-dynamic'

const DEFAULT_PAGE_SIZE = 24
const MAX_PAGE_SIZE = 100

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const sp = request.nextUrl.searchParams
  const storeId = sp.get('storeId')
  if (!storeId) return NextResponse.json({ error: 'storeId required' }, { status: 400 })

  // Ownership is checked explicitly as well as by RLS: an unowned storeId should
  // 404 rather than quietly return an empty page, which reads like "no creatives".
  const { data: store } = await supabase
    .from('stores').select('id').eq('id', storeId).eq('user_id', user.id).single()
  if (!store) return NextResponse.json({ error: 'Store not found' }, { status: 404 })

  const page = Math.max(1, parseInt(sp.get('page') || '1', 10) || 1)
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, parseInt(sp.get('pageSize') || String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE)
  )
  const from = (page - 1) * pageSize

  const select = `
    id, url, width, height, created_at, asset_type,
    variant_id, template_id, product_id,
    products!inner(id, title, handle, vendor),
    product_variants(id, title, sku),
    templates(id, name)
  `

  const assetTypeParam = sp.get('assetType')
  const assetType: AssetType = ALL_ASSET_TYPES.includes(assetTypeParam as AssetType)
    ? (assetTypeParam as AssetType)
    : 'catalog'

  let query = supabase
    .from('generated_creatives')
    .select(select, { count: 'exact' })
    .eq('store_id', storeId)
    .eq('asset_type', assetType)

  const templateId = sp.get('templateId')
  const productId = sp.get('productId')
  const variantId = sp.get('variantId')
  const search = sp.get('search')

  if (templateId) query = query.eq('template_id', templateId)
  if (productId) query = query.eq('product_id', productId)
  if (variantId) query = query.eq('variant_id', variantId)
  // Filtering by product title requires the inner join above, which is why
  // products is joined with !inner rather than as an optional relation.
  if (search) query = query.ilike('products.title', `%${search}%`)

  const { data, count, error } = await query
    .order('created_at', { ascending: false })
    .range(from, from + pageSize - 1)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const total = count ?? 0
  return NextResponse.json({
    creatives: data ?? [],
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  })
}
