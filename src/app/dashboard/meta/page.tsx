import { createClient } from '@/lib/supabase/server'
import { getActiveStore } from '@/lib/active-store'
import { MetaStoreCard } from '@/components/meta/meta-store-card'

export const dynamic = 'force-dynamic'

export default async function MetaPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const { activeStoreId } = await getActiveStore()

  const { data: stores } = await supabase
    .from('stores')
    .select('id, shop_name, shop_domain, feed_token, meta_catalog_id, meta_feed_status, meta_feed_last_sync')
    .eq('user_id', user!.id)
    .eq('id', activeStoreId || '')
    .order('created_at', { ascending: false })

  // Per-store counts: products synced, completed creatives, failed creatives,
  // and pending jobs. Done with lightweight count queries per store.
  const cards = await Promise.all((stores || []).map(async (store) => {
    const [
      { count: products },
      { count: generatedCount },
      { count: failedCount },
      { count: pendingJobs },
    ] = await Promise.all([
      supabase.from('products').select('id', { count: 'exact', head: true })
        .eq('store_id', store.id).eq('status', 'active'),
      supabase
        .from('generated_images')
        .select('id, products!inner(store_id)', { count: 'exact', head: true })
        .eq('products.store_id', store.id)
        .eq('status', 'completed'),
      supabase
        .from('generated_images')
        .select('id, products!inner(store_id)', { count: 'exact', head: true })
        .eq('products.store_id', store.id)
        .eq('status', 'failed'),
      supabase
        .from('generation_jobs').select('id', { count: 'exact', head: true })
        .eq('store_id', store.id).in('status', ['pending', 'processing']),
    ])

    return {
      store,
      stats: {
        products: products || 0,
        generated: generatedCount || 0,
        failed: failedCount || 0,
        pendingJobs: pendingJobs || 0,
      },
    }
  }))

  return (
    <div className="max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Meta Commerce Manager</h1>
        <p className="text-muted-foreground mt-1">
          Connect catalogs and serve generated creatives to Meta via an XML product feed.
        </p>
      </div>

      {cards.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No stores connected yet. Add a store in Settings first.
        </p>
      )}

      <div className="space-y-4">
        {cards.map(({ store, stats }) => (
          <MetaStoreCard key={store.id} store={store as any} stats={stats} />
        ))}
      </div>
    </div>
  )
}
