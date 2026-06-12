import { TemplateBuilderClient } from '@/components/builder/template-builder-client'
import { createClient } from '@/lib/supabase/server'

export default async function NewTemplatePage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const { data: categories } = await supabase
    .from('template_categories')
    .select('*')
    .eq('user_id', user!.id)
    .order('name')

  const { data: stores } = await supabase.from('stores').select('id').eq('user_id', user!.id)
  const storeIds = (stores || []).map(s => s.id)
  let previewProduct = null
  if (storeIds.length > 0) {
    const { data: products } = await supabase
      .from('products')
      .select('title, price, compare_at_price, vendor, product_type, product_images(src, is_primary)')
      .in('store_id', storeIds)
      .limit(1)
    const p = products?.[0] as any
    if (p) {
      const img = p.product_images?.find((i: any) => i.is_primary) || p.product_images?.[0]
      previewProduct = {
        title: p.title, price: p.price, compare_at_price: p.compare_at_price,
        vendor: p.vendor, product_type: p.product_type, imageUrl: img?.src ?? null,
      }
    }
  }

  return <TemplateBuilderClient categories={categories || []} previewProduct={previewProduct} />
}