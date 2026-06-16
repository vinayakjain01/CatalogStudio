import { createClient } from '@/lib/supabase/server'
import { getActiveStore } from '@/lib/active-store'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ShoppingBag, Layers, ImageIcon, Store } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'

export default async function DashboardPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const { activeStoreId, stores: storeList } = await getActiveStore()

  // Full store row for the active store (for sync status display).
  const { data: stores } = await supabase
    .from('stores')
    .select('*')
    .eq('user_id', user!.id)
    .order('created_at', { ascending: true })

  const activeStore = stores?.find(s => s.id === activeStoreId) || null

  // All metrics scoped to the ACTIVE store only — never aggregated.
  let productCount = 0, templateCount = 0, creativeCount = 0
  if (activeStoreId) {
    const productIdsRes = await supabase.from('products').select('id').eq('store_id', activeStoreId)
    const productIds = (productIdsRes.data || []).map(p => p.id)

    const [pc, tc, cc] = await Promise.all([
      supabase.from('products').select('*', { count: 'exact', head: true }).eq('store_id', activeStoreId),
      supabase.from('templates').select('*', { count: 'exact', head: true }).eq('store_id', activeStoreId),
      productIds.length > 0
        ? supabase.from('generated_images').select('*', { count: 'exact', head: true }).in('product_id', productIds)
        : Promise.resolve({ count: 0 } as any),
    ])
    productCount = pc.count || 0
    templateCount = tc.count || 0
    creativeCount = cc.count || 0
  }

  const stats = [
    { label: 'Connected stores', value: storeList.length, icon: Store },
    { label: 'Products synced', value: productCount, icon: ShoppingBag },
    { label: 'Templates', value: templateCount, icon: Layers },
    { label: 'Creatives generated', value: creativeCount, icon: ImageIcon },
  ]

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="text-muted-foreground mt-1">Your catalog creative automation overview</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map(({ label, value, icon: Icon }) => (
          <Card key={label}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
              <Icon className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-semibold">{value.toLocaleString('en-IN')}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {activeStore && (
        <div>
          <h2 className="text-base font-medium mb-3">Store sync status</h2>
          <div className="space-y-2">
            <Card key={activeStore.id}>
              <CardContent className="p-4 flex items-center justify-between">
                <div>
                  <p className="font-medium text-sm">{activeStore.shop_name || activeStore.shop_domain}</p>
                  <p className="text-xs text-muted-foreground">{activeStore.shop_domain}</p>
                </div>
                <p className="text-xs text-muted-foreground">
                  {activeStore.last_synced_at
                    ? `Synced ${formatDistanceToNow(new Date(activeStore.last_synced_at), { addSuffix: true })}`
                    : 'Never synced'}
                </p>
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      {!activeStore && (
        <Card className="border-dashed">
          <CardContent className="text-center py-12 text-muted-foreground">
            <Store className="h-8 w-8 mx-auto mb-3 opacity-40" />
            <p className="font-medium">No store connected yet</p>
            <p className="text-sm mt-1">Go to Settings to connect your Shopify store and start syncing products.</p>
          </CardContent>
        </Card>
      )}
    </div>
  )
}