import { createClient } from '@/lib/supabase/server'
import { RulesClient } from '@/components/rules/rules-client'

export default async function RulesPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const [{ data: stores }, { data: templates }] = await Promise.all([
    supabase.from('stores').select('id, shop_name, shop_domain').eq('user_id', user!.id),
    supabase.from('templates').select('id, name').eq('user_id', user!.id).eq('is_active', true),
  ])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Rules Engine</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Automatically assign templates to products based on tags, vendor, type, or discount
        </p>
      </div>
      <RulesClient stores={stores || []} templates={templates || []} />
    </div>
  )
}