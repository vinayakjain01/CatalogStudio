import { createClient } from '@/lib/supabase/server'

export interface EditorPreviewProduct {
  id: string
  title: string
  price: number
  compare_at_price: number | null
  vendor: string | null
  product_type: string | null
  imageUrl: string | null
}

// Seeds the template editor's live preview: the user's first store and a page
// of its products. The editor's dropdown lazily loads the full list on open.
export async function getEditorPreviewSeed(userId: string): Promise<{
  storeId?: string
  previewProducts: EditorPreviewProduct[]
}> {
  const supabase = await createClient()

  // Use the active store so the editor previews the right store's products.
  const { getActiveStore } = await import('@/lib/active-store')
  const { activeStoreId } = await getActiveStore()
  const storeId = activeStoreId as string | undefined
  if (!storeId) return { storeId: undefined, previewProducts: [] }

  const { data: products } = await supabase
    .from('products')
    .select('id, title, price, compare_at_price, vendor, product_type, product_images(src, is_primary)')
    .eq('store_id', storeId)
    .eq('status', 'active')
    .order('title')
    .limit(24)

  const previewProducts: EditorPreviewProduct[] = (products || []).map((p: any) => {
    const img = p.product_images?.find((i: any) => i.is_primary) || p.product_images?.[0]
    return {
      id: p.id, title: p.title, price: p.price, compare_at_price: p.compare_at_price,
      vendor: p.vendor, product_type: p.product_type, imageUrl: img?.src ?? null,
    }
  })

  return { storeId, previewProducts }
}