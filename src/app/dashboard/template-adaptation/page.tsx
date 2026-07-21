import { getActiveStore } from '@/lib/active-store'
import { TemplateAdaptationClient } from '@/components/template-adaptation/template-adaptation-client'

export default async function TemplateAdaptationPage() {
  const { activeStoreId, stores } = await getActiveStore()

  // Pass ONLY the active store so the client never shows another store's data
  // (matches the Creatives page's convention).
  const activeStore = stores.find(s => s.id === activeStoreId)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Template Adaptation</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Upload a reference advertisement and your own product photos — Craftify swaps in your model automatically.
        </p>
      </div>
      <TemplateAdaptationClient
        store={activeStore ? { id: activeStore.id, shop_name: activeStore.shop_name || '', shop_domain: activeStore.shop_domain } : null}
      />
    </div>
  )
}
