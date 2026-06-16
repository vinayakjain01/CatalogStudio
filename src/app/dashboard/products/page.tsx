import { Suspense } from 'react'
import { createClient } from '@/lib/supabase/server'
import { getActiveStore } from '@/lib/active-store'
import { ProductsTable } from '@/components/products/products-table'
import { ProductsPagination } from '@/components/products/products-pagination'
import { ProductsSearch } from '@/components/products/products-search'

const PAGE_SIZE = 25

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string; tag?: string; page?: string }>
}) {

  const supabase = await createClient()
  const { search, tag, page } = await searchParams

  const currentPage = Math.max(1, parseInt(page || '1', 10) || 1)
  const from = (currentPage - 1) * PAGE_SIZE
  const to = from + PAGE_SIZE - 1

  // Active store only — never aggregate across stores.
  const { activeStoreId } = await getActiveStore()

  if (!activeStoreId) {
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

  // Build base query (for count)
  let countQuery = supabase
    .from('products')
    .select('id', { count: 'exact', head: true })
    .eq('store_id', activeStoreId)

  if (search) countQuery = countQuery.ilike('title', `%${search}%`)
  if (tag) countQuery = countQuery.contains('tags', [tag])

  const { count: totalCount } = await countQuery

  // Build paginated query
  let query = supabase
    .from('products')
    .select(`
      id, title, vendor, product_type, tags, price, compare_at_price,
      inventory_quantity, status, updated_at,
      product_images!inner(src, is_primary)
    `)
    .eq('store_id', activeStoreId)
    .eq('product_images.is_primary', true)
    .order('updated_at', { ascending: false })
    .range(from, to)

  if (search) query = query.ilike('title', `%${search}%`)
  if (tag) query = query.contains('tags', [tag])

  const { data: products } = await query

  const totalPages = Math.max(1, Math.ceil((totalCount || 0) / PAGE_SIZE))

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Products</h1>
          <p className="text-muted-foreground text-sm mt-1">
            {totalCount || 0} products total
          </p>
        </div>
      </div>
      <ProductsTable products={products || []} />
      <ProductsPagination
        currentPage={currentPage}
        totalPages={totalPages}
        totalCount={totalCount || 0}
        pageSize={PAGE_SIZE}
      />
    </div>
  )
}