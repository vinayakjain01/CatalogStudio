import Link from 'next/link'
import { Suspense } from 'react'
import { createClient } from '@/lib/supabase/server'
import { getActiveStore } from '@/lib/active-store'
import { Button } from '@/components/ui/button'
import { Store, Package } from 'lucide-react'
import { EmptyState } from '@/components/ui/empty-state'
import { ProductsTable } from '@/components/products/products-table'
import { ProductsPagination } from '@/components/products/products-pagination'
import { ProductsSearch } from '@/components/products/products-search'

// 10 per page: each row loads a Cloudinary thumbnail, so a smaller page means
// fewer image requests per navigation and a faster first paint.
const PAGE_SIZE = 10

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
        <EmptyState
          icon={Store}
          title="Connect your Shopify store"
          description="Sync your catalog to bring products, variants and images into Craftify."
          action={
            <Button size="lg" asChild>
              <Link href="/dashboard/settings">
                <Store className="h-4 w-4" />
                Connect store
              </Link>
            </Button>
          }
        />
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

  // Build paginated query
  let query = supabase
    .from('products')
    .select(`
      id, title, vendor, product_type, tags, status, updated_at,
      product_images(src, is_primary),
      product_variants(id, price, compare_at_price, inventory_quantity, is_sold_out)
    `)
    .eq('store_id', activeStoreId)
    .eq('product_images.is_primary', true)
    .order('updated_at', { ascending: false })
    .range(from, to)

  if (search) query = query.ilike('title', `%${search}%`)
  if (tag) query = query.contains('tags', [tag])

  const [{ count: totalCount }, { data: products }, { data: store }] = await Promise.all([
    countQuery,
    query,
    // Prices must render in the store's own currency, not a hardcoded one.
    supabase.from('stores').select('currency').eq('id', activeStoreId).single(),
  ])

  const totalPages = Math.max(1, Math.ceil((totalCount || 0) / PAGE_SIZE))

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Products</h1>
          <p className="text-muted-foreground text-sm mt-1">
            {totalCount || 0} product{totalCount === 1 ? '' : 's'} total
            {search ? ` — showing results for "${search}"` : ''}
          </p>
        </div>

        {/* Suspense is required: ProductsSearch reads useSearchParams(), and
            Next bails a Client Component using it to client-only rendering up
            to the nearest Suspense boundary during prerendering checks. */}
        <Suspense fallback={<div className="h-9 w-72 animate-pulse rounded-md bg-muted" />}>
          <ProductsSearch defaultValue={search} />
        </Suspense>
      </div>
      {(products?.length ?? 0) === 0 ? (
        <EmptyState
          icon={Package}
          title={search || tag ? 'No products match those filters' : 'Sync your catalog'}
          description={
            search || tag
              ? 'Try a different search term, or clear the filter to see everything.'
              : 'Run a sync from Settings to pull your Shopify products and variants in.'
          }
          action={
            <Button size="lg" asChild>
              <Link href="/dashboard/settings">Go to Settings</Link>
            </Button>
          }
        />
      ) : (
        <ProductsTable products={products || []} currency={store?.currency || 'USD'} />
      )}
      <ProductsPagination
        currentPage={currentPage}
        totalPages={totalPages}
        totalCount={totalCount || 0}
        pageSize={PAGE_SIZE}
      />
    </div>
  )
}