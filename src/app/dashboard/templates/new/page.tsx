import { createClient } from '@/lib/supabase/server'
import { TemplateBuilderClient } from '@/components/builder/template-builder-client'

export default async function NewTemplatePage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const { data: categories } = await supabase
    .from('template_categories')
    .select('*')
    .eq('user_id', user!.id)
    .order('name')

  // Get stores first
  const { data: stores } = await supabase
    .from('stores')
    .select('id')
    .eq('user_id', user!.id)

  const storeIds = stores?.map(s => s.id) ?? []

  // Safe conditional — don't call Supabase in a ternary
  let previewProducts: any[] = []

  if (storeIds.length > 0) {
    const { data } = await supabase
      .from('products')
      .select(`
        id, title, price, compare_at_price, vendor, product_type,
        product_images(src, is_primary)
      `)
      .in('store_id', storeIds)
      .eq('status', 'active')
      .order('updated_at', { ascending: false })
      .limit(100)

    previewProducts = data ?? []
  }

  return (
    <TemplateBuilderClient
      categories={categories ?? []}
      previewProducts={previewProducts}
    />
  )
}