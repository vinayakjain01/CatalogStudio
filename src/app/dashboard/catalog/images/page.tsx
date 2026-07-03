import { createClient } from '@/lib/supabase/server'
import { LoadDriveImagesClient } from '@/components/catalog/load-drive-images-client'

export default async function LoadDriveImagesPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const { data: stores } = await supabase
    .from('stores')
    .select('id, shop_name, display_name, source')
    .eq('user_id', user!.id)
    .order('created_at', { ascending: false })

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Load Images from Google Drive</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Paste a Google Drive folder link — all images load automatically
        </p>
      </div>
      <LoadDriveImagesClient stores={stores || []} />
    </div>
  )
}