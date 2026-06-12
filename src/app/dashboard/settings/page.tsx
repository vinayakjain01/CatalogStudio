import { createClient } from '@/lib/supabase/server'
import { ConnectStoreForm } from '@/components/settings/connect-store-form'
import { StoreCard } from '@/components/settings/store-card'
import { OAuthStatusBanner } from '@/components/settings/oauth-status-banner'

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ success?: string; error?: string }>
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const { success, error } = await searchParams

  const { data: stores } = await supabase
    .from('stores')
    .select('id, shop_name, shop_domain, currency, last_synced_at, is_active, feed_token')
    .eq('user_id', user!.id)
    .order('created_at', { ascending: false })

  return (
    <div className="max-w-2xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-muted-foreground mt-1">Manage your connected Shopify stores</p>
      </div>

      <OAuthStatusBanner success={success} error={error} />

      {stores && stores.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-base font-medium">Connected stores</h2>
          {stores.map(store => (
            <StoreCard key={store.id} store={store as any} />
          ))}
        </div>
      )}

      <div>
        <h2 className="text-base font-medium mb-3">Add a store</h2>
        <ConnectStoreForm />
      </div>
    </div>
  )
}