import { createClient } from '@/lib/supabase/server'
import { ProductsTable } from '@/components/products/products-table'
import { Badge } from '@/components/ui/badge'

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string; tag?: string }>
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const { search, tag } = await searchParams

  // Get user's stores
  const { data: stores } = await supabase
    .from('stores')
    .select('id')
    .eq('user_id', user!.id)

  const storeIds = stores?.map(s => s.id) || []

  if (storeIds.length === 0) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold">Products</h1>
        <div className="text-center py-20 text-muted-foreground">
          <p>No stores connected yet.</p>
          <p className="text-sm mt-1">Go to Settings to connect your Shopify store.</p>
        </div>
      </div>
    )
  }

  // Build query
  let query = supabase
    .from('products')
    .select(`
      id, title, vendor, product_type, tags, price, compare_at_price,
      inventory_quantity, status, updated_at,
      product_images!inner(src, is_primary)
    `)
    .in('store_id', storeIds)
    .eq('product_images.is_primary', true)
    .order('updated_at', { ascending: false })
    .limit(200)

  if (search) {
    query = query.ilike('title', `%${search}%`)
  }

  if (tag) {
    query = query.contains('tags', [tag])
  }

  const { data: products } = await query

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Products</h1>
          <p className="text-muted-foreground text-sm mt-1">
            {products?.length || 0} products synced
          </p>
        </div>
      </div>
      <ProductsTable products={products || []} />
    </div>
  )
}