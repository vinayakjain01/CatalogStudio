import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { getActiveStore } from '@/lib/active-store'
import { Button } from '@/components/ui/button'
import { FolderUp } from 'lucide-react'
import { ProductsTable } from '@/components/products/products-table'
import { ProductsPagination } from '@/components/products/products-pagination'

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
        <div className="text-center py-20 space-y-4">
          <div className="text-muted-foreground">
            <p>No products yet.</p>
            <p className="text-sm mt-1">
              Upload a folder of product images, or connect a Shopify store in Settings.
            </p>
          </div>
          <Button size="lg" asChild>
            <Link href="/dashboard/upload">
              <FolderUp className="h-4 w-4" />
              Upload folder
            </Link>
          </Button>
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

  // Build paginated query
  let query = supabase
    .from('products')
    .select(`
      id, title, vendor, product_type, tags, price, compare_at_price,
      inventory_quantity, status, updated_at,
      product_images(src, is_primary)
    `)
    .eq('store_id', activeStoreId)
    .eq('product_images.is_primary', true)
    .order('updated_at', { ascending: false })
    .range(from, to)

  if (search) query = query.ilike('title', `%${search}%`)
  if (tag) query = query.contains('tags', [tag])

  const [{ count: totalCount }, { data: products }] = await Promise.all([
    countQuery,
    query,
  ])

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
        <Button variant="outline" size="lg" asChild>
          <Link href="/dashboard/upload">
            <FolderUp className="h-4 w-4" />
            Upload folder
          </Link>
        </Button>
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