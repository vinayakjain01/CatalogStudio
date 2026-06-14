import { createClient } from '@/lib/supabase/server'
import { MetaStoreCard } from '@/components/meta/meta-store-card'

export const dynamic = 'force-dynamic'

export default async function MetaPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const { data: stores } = await supabase
    .from('stores')
    .select('id, shop_name, shop_domain, feed_token, meta_catalog_id, meta_feed_status, meta_feed_last_sync')
    .eq('user_id', user!.id)
    .order('created_at', { ascending: false })

  // Per-store counts: products synced, completed creatives, failed creatives,
  // and pending jobs. Done with lightweight count queries per store.
  const cards = await Promise.all((stores || []).map(async (store) => {
    const [{ count: products }, { data: productIds }] = await Promise.all([
      supabase.from('products').select('id', { count: 'exact', head: true })
        .eq('store_id', store.id).eq('status', 'active'),
      supabase.from('products').select('id').eq('store_id', store.id),
    ])

    const ids = (productIds || []).map((p: any) => p.id)
    let generated = 0, failed = 0
    if (ids.length > 0) {
      const [{ count: gen }, { count: fail }] = await Promise.all([
        supabase.from('generated_images').select('id', { count: 'exact', head: true })
          .in('product_id', ids).eq('status', 'completed'),
        supabase.from('generated_images').select('id', { count: 'exact', head: true })
          .in('product_id', ids).eq('status', 'failed'),
      ])
      generated = gen || 0
      failed = fail || 0
    }

    const { count: pendingJobs } = await supabase
      .from('generation_jobs').select('id', { count: 'exact', head: true })
      .eq('store_id', store.id).in('status', ['pending', 'processing'])

    return {
      store,
      stats: {
        products: products || 0,
        generated,
        failed,
        pendingJobs: pendingJobs || 0,
      },
    }
  }))

  return (
    <div className="max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Meta Commerce Manager</h1>
        <p className="text-muted-foreground mt-1">
          Connect catalogs and serve generated creatives to Meta via a supplementary feed.
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