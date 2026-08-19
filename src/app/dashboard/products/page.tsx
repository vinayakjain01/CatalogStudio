import Link from 'next/link'
import { Suspense } from 'react'
import { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { getActiveStore } from '@/lib/active-store'
import { Button } from '@/components/ui/button'
import { Store, Package } from 'lucide-react'
import { EmptyState } from '@/components/ui/empty-state'
import { ProductsTable } from '@/components/products/products-table'
import { ProductsPagination } from '@/components/products/products-pagination'
import { ProductsSearch } from '@/components/products/products-search'
import { StockToggle } from '@/components/products/stock-toggle'

// 10 per page: each row loads a Cloudinary thumbnail, so a smaller page means
// fewer image requests per navigation and a faster first paint.
const PAGE_SIZE = 10

const PRODUCT_COLUMNS = `
  id, title, vendor, product_type, tags, status, updated_at,
  product_images(src, is_primary),
  product_variants(id, price, compare_at_price, inventory_quantity, is_sold_out)
`

/**
 * Every product id (of this store, matching search/tag) with at least one
 * in-stock variant — for the "In Stock" toggle.
 *
 * `product_variants!inner(is_sold_out)` turns the embed into a real SQL JOIN,
 * which is what makes filtering on it restrict the PARENT (product) rows —
 * but that join also means a product with several in-stock variants comes
 * back once per matching variant, not once per product, so this dedupes by
 * id. Paginated with a deterministic order for the same reason every other
 * chunked/paginated Supabase read in this codebase is: an unpaginated `.in()`
 * or embed query is silently capped at the project's per-request row limit
 * (see generation-queue.ts's fetchAllChunked) — with 741 products and
 * several variants each, the join's row count can exceed that easily.
 */
async function fetchInStockProductIds(
  storeId: string,
  search: string | undefined,
  tag: string | undefined,
  supabase: SupabaseClient
): Promise<Array<{ id: string; updated_at: string }>> {
  const seen = new Map<string, string>() // id -> updated_at
  const PAGE = 1000

  for (let from = 0; ; from += PAGE) {
    let q = supabase
      .from('products')
      .select('id, updated_at, product_variants!inner(is_sold_out)')
      .eq('store_id', storeId)
      .eq('product_variants.is_sold_out', false)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)

    if (search) q = q.ilike('title', `%${search}%`)
    if (tag) q = q.contains('tags', [tag])

    const { data, error } = await q
    if (error) throw new Error(error.message)
    if (!data || data.length === 0) break
    for (const row of data as any[]) seen.set(row.id, row.updated_at)
    if (data.length < PAGE) break
  }

  return Array.from(seen, ([id, updated_at]) => ({ id, updated_at }))
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
}

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string; tag?: string; page?: string; stock?: string }>
}) {

  const supabase = await createClient()
  const { search, tag, page, stock: stockParam } = await searchParams
  const stock = stockParam === 'in_stock' ? 'in_stock' : 'all'

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

  // Runs alongside whichever branch below, rather than blocking on it first.
  const storePromise = supabase
    .from('stores').select('currency').eq('id', activeStoreId).single()

  let totalCount = 0
  let products: any[] = []

  if (stock === 'in_stock') {
    // Two-step: first resolve every matching product id (in-stock, honouring
    // search/tag), sorted + paginated in JS, THEN fetch the current page's 10
    // full rows with their FULL variant/image sets — not just the in-stock
    // variants — so ProductsTable's own stock/price rollups (which need every
    // variant to be correct) are unaffected by which toggle is selected.
    const allInStock = await fetchInStockProductIds(activeStoreId, search, tag, supabase)
    totalCount = allInStock.length
    const pageIds = allInStock.slice(from, to + 1).map(r => r.id)

    if (pageIds.length > 0) {
      const { data } = await supabase
        .from('products')
        .select(PRODUCT_COLUMNS)
        .in('id', pageIds)
        .eq('product_images.is_primary', true)

      // .in() does not preserve the requested order — reinstate the
      // updated_at-desc order fetchInStockProductIds already sorted by.
      const byId = new Map((data ?? []).map((p: any) => [p.id, p]))
      products = pageIds.map(id => byId.get(id)).filter(Boolean)
    }
  } else {
    let countQuery = supabase
      .from('products')
      .select('id', { count: 'exact', head: true })
      .eq('store_id', activeStoreId)

    if (search) countQuery = countQuery.ilike('title', `%${search}%`)
    if (tag) countQuery = countQuery.contains('tags', [tag])

    let query = supabase
      .from('products')
      .select(PRODUCT_COLUMNS)
      .eq('store_id', activeStoreId)
      .eq('product_images.is_primary', true)
      .order('updated_at', { ascending: false })
      .range(from, to)

    if (search) query = query.ilike('title', `%${search}%`)
    if (tag) query = query.contains('tags', [tag])

    const [{ count }, { data }] = await Promise.all([countQuery, query])
    totalCount = count || 0
    products = data || []
  }

  const { data: store } = await storePromise
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE))

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold">Products</h1>
            {/* Suspense is required: StockToggle reads useSearchParams(), and
                Next bails a Client Component using it to client-only
                rendering up to the nearest Suspense boundary during
                prerendering checks — same reason ProductsSearch below needs it. */}
            <Suspense fallback={<div className="h-7 w-40 animate-pulse rounded-full bg-muted" />}>
              <StockToggle current={stock} />
            </Suspense>
          </div>
          <p className="text-muted-foreground text-sm mt-1">
            {totalCount || 0} product{totalCount === 1 ? '' : 's'}
            {stock === 'in_stock' ? ' in stock' : ' total'}
            {search ? ` — showing results for "${search}"` : ''}
          </p>
        </div>

        <Suspense fallback={<div className="h-9 w-72 animate-pulse rounded-md bg-muted" />}>
          <ProductsSearch defaultValue={search} />
        </Suspense>
      </div>
      {(products?.length ?? 0) === 0 ? (
        <EmptyState
          icon={Package}
          title={
            search || tag ? 'No products match those filters'
              : stock === 'in_stock' ? 'No in-stock products'
              : 'Sync your catalog'
          }
          description={
            search || tag
              ? 'Try a different search term, or clear the filter to see everything.'
              : stock === 'in_stock'
                ? 'Every synced product is currently sold out. Switch to "All Products" to see them.'
                : 'Run a sync from Settings to pull your Shopify products and variants in.'
          }
          action={
            stock === 'in_stock' && !search && !tag ? undefined : (
              <Button size="lg" asChild>
                <Link href="/dashboard/settings">Go to Settings</Link>
              </Button>
            )
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