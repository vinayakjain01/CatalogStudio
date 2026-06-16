import { createClient } from '@/lib/supabase/server'
import { getActiveStore } from '@/lib/active-store'
import { CreativesClient } from '@/components/creatives/creatives-client'

export default async function CreativesPage() {
  const supabase = await createClient()
  const { activeStoreId, stores } = await getActiveStore()

  // Pass ONLY the active store so the client never shows another store's data.
  const activeStores = stores
    .filter(s => s.id === activeStoreId)
    .map(s => ({ id: s.id, shop_name: s.shop_name || '', shop_domain: s.shop_domain }))

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Creatives</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Generate and manage your catalog creatives
        </p>
      </div>
      <CreativesClient stores={activeStores} />
    </div>
  )
}