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

  // Fetch products for preview selector
  const { data: stores } = await supabase.from('stores').select('id').eq('user_id', user!.id)
  const storeIds = stores?.map(s => s.id) || []

  const { data: previewProducts } = storeIds.length > 0
    ? await supabase
        .from('products')
        .select('id, title, price, compare_at_price, vendor, product_type, product_images(src, is_primary)')
        .in('store_id', storeIds)
        .eq('status', 'active')
        .order('updated_at', { ascending: false })
        .limit(100)
    : { data: [] }

  return (
    <TemplateBuilderClient
      categories={categories || []}
      previewProducts={previewProducts || []}
    />
  )
}