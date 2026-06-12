import { createClient } from '@/lib/supabase/server'
import { CreativesClient } from '@/components/creatives/creatives-client'

export default async function CreativesPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const { data: stores } = await supabase
    .from('stores')
    .select('id, shop_name, shop_domain')
    .eq('user_id', user!.id)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Creatives</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Generate and manage your catalog creatives
        </p>
      </div>
      <CreativesClient stores={stores || []} />
    </div>
  )
}