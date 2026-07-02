import { createClient } from '@/lib/supabase/server'
import { CatalogImportClient } from '@/components/catalog/catalog-import-client'

export default async function CatalogImportPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  // Get line-sheet stores for this user
  const { data: linesheetStores } = await supabase
    .from('stores')
    .select('id, shop_name, display_name, created_at')
    .eq('user_id', user!.id)
    .eq('source', 'line_sheet')
    .order('created_at', { ascending: false })

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Line Sheet Import</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Import products from Excel, CSV, Google Sheets, or Google Drive
        </p>
      </div>
      <CatalogImportClient existingCatalogs={linesheetStores || []} />
    </div>
  )
}