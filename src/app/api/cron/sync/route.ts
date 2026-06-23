import { NextRequest, NextResponse } from 'next/server'
import { createClient as createSupabaseAdmin } from '@supabase/supabase-js'
import { syncStoreProducts } from '@/lib/shopify-sync'

function getAdminClient() {
  return createSupabaseAdmin(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = getAdminClient()
  const { data: stores } = await supabase
    .from('stores')
    .select('*')
    .eq('is_active', true)

  if (!stores || stores.length === 0) {
    return NextResponse.json({ message: 'No active stores' })
  }

  const results = []

  for (const store of stores) {
    try {
      const synced = await syncStoreProducts({
        storeId: store.id,
        syncType: 'cron',
        incremental: true,
        supabase,
      })
      results.push({ store: store.shop_domain, synced })
    } catch (err: any) {
      results.push({ store: store.shop_domain, error: err.message })
    }
  }

  return NextResponse.json({ results })
}
