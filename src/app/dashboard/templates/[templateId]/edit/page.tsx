import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { TemplateBuilderClient } from '@/components/builder/template-builder-client'

export default async function EditTemplatePage({
  params,
}: {
  params: Promise<{ templateId: string }>
}) {
  const { templateId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const [{ data: template }, { data: categories }] = await Promise.all([
    supabase.from('templates').select('*').eq('id', templateId).eq('user_id', user!.id).single(),
    supabase.from('template_categories').select('*').eq('user_id', user!.id).order('name'),
  ])

  if (!template) notFound()

  // Fetch one real product for live preview (first store, first product w/ image).
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

  return (
    <TemplateBuilderClient
      template={template}
      categories={categories || []}
      previewProduct={previewProduct}
    />
  )
}