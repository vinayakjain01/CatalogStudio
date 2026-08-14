import { createClient } from '@/lib/supabase/server'
import { getUser } from '@/lib/supabase/get-user'
import { getActiveStore } from '@/lib/active-store'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ShoppingBag, Layers, ImageIcon, Store } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'

export default async function DashboardPage() {
  // Both calls share one Supabase auth round-trip (React cache).
  const [user, { activeStoreId, stores: storeList }] = await Promise.all([
    getUser(),
    getActiveStore(),
  ])

  const supabase = await createClient()

  // All metric queries run in parallel — previously 4 sequential calls.
  const countQueries = activeStoreId
    ? Promise.all([
        supabase.from('products').select('*', { count: 'exact', head: true }).eq('store_id', activeStoreId),
        supabase.from('templates').select('*', { count: 'exact', head: true }).eq('store_id', activeStoreId),
        // generated_creatives carries store_id directly, so this no longer needs
        // an inner join through products — and it counts per VARIANT, which is
        // what actually gets generated in v2.
        supabase
          .from('generated_creatives')
          .select('id', { count: 'exact', head: true })
          .eq('store_id', activeStoreId),
      ])
    : Promise.resolve([{ count: 0 }, { count: 0 }, { count: 0 }] as Array<{ count: number | null }>)

  const activeStoreQuery = activeStoreId
    ? supabase.from('stores').select('*').eq('id', activeStoreId).single()
    : Promise.resolve({ data: null })

  const [[pc, tc, cc], { data: activeStore }] = await Promise.all([
    countQueries,
    activeStoreQuery,
  ])

  const productCount  = pc.count  || 0
  const templateCount = tc.count  || 0
  const creativeCount = cc.count  || 0

  const stats = [
    { label: 'Connected stores',    value: storeList.length, icon: Store },
    { label: 'Products synced',     value: productCount,     icon: ShoppingBag },
    { label: 'Templates',           value: templateCount,    icon: Layers },
    { label: 'Creatives generated', value: creativeCount,    icon: ImageIcon },
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
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Active Store</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <p className="font-medium">{activeStore.shop_name || activeStore.shop_domain}</p>
            <p className="text-xs text-muted-foreground">{activeStore.shop_domain}</p>
            {activeStore.last_sync_at && (
              <p className="text-xs text-muted-foreground">
                Last synced {formatDistanceToNow(new Date(activeStore.last_sync_at), { addSuffix: true })}
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}