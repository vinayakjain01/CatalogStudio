import { createClient } from '@/lib/supabase/server'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ShoppingBag, Layers, ImageIcon, Store } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'

export default async function DashboardPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const { data: stores } = await supabase
    .from('stores')
    .select('*')
    .eq('user_id', user!.id)

  const storeIds = stores?.map(s => s.id) || []

  const [{ count: productCount }, { count: templateCount }, { count: creativeCount }] = await Promise.all([
    supabase.from('products').select('*', { count: 'exact', head: true }).in('store_id', storeIds),
    supabase.from('templates').select('*', { count: 'exact', head: true }).eq('user_id', user!.id),
    supabase.from('generated_images').select('*', { count: 'exact', head: true })
      .in('product_id',
        storeIds.length > 0
          ? (await supabase.from('products').select('id').in('store_id', storeIds)).data?.map(p => p.id) || []
          : []
      ),
  ])

  const stats = [
    { label: 'Connected stores', value: stores?.length || 0, icon: Store },
    { label: 'Products synced', value: productCount || 0, icon: ShoppingBag },
    { label: 'Templates', value: templateCount || 0, icon: Layers },
    { label: 'Creatives generated', value: creativeCount || 0, icon: ImageIcon },
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

      {stores && stores.length > 0 && (
        <div>
          <h2 className="text-base font-medium mb-3">Store sync status</h2>
          <div className="space-y-2">
            {stores.map(store => (
              <Card key={store.id}>
                <CardContent className="p-4 flex items-center justify-between">
                  <div>
                    <p className="font-medium text-sm">{store.shop_name || store.shop_domain}</p>
                    <p className="text-xs text-muted-foreground">{store.shop_domain}</p>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {store.last_synced_at
                      ? `Synced ${formatDistanceToNow(new Date(store.last_synced_at), { addSuffix: true })}`
                      : 'Never synced'}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      {(!stores || stores.length === 0) && (
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