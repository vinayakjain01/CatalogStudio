import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createSupabaseAdmin } from '@supabase/supabase-js'
import { syncStoreProducts } from '@/lib/shopify-sync'

function getAdminClient() {
  return createSupabaseAdmin(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

async function runSync(storeId: string, supabase: ReturnType<typeof getAdminClient>) {
  return syncStoreProducts({
    storeId,
    syncType: 'manual',
    autoEnqueueChanged: true,
    supabase,
  })
}

// Called by the user from the UI (authenticated)
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ storeId: string }> }
) {
  const { storeId } = await params

  // Allow internal calls (from callback or cron) via secret header
  const internalSecret = request.headers.get('x-internal-secret')
  if (internalSecret === process.env.CRON_SECRET) {
    try {
      const supabase = getAdminClient()
      const synced = await runSync(storeId, supabase)
      return NextResponse.json({ success: true, productsSync: synced })
    } catch (err: any) {
      return NextResponse.json({ error: err.message }, { status: 500 })
    }
  }

  // Normal user-authenticated call
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Verify the store belongs to this user
  const { data: store } = await supabase
    .from('stores')
    .select('id')
    .eq('id', storeId)
    .eq('user_id', user.id)
    .single()

  if (!store) {
    return NextResponse.json({ error: 'Store not found' }, { status: 404 })
  }

  try {
    const adminSupabase = getAdminClient()
    const synced = await runSync(storeId, adminSupabase)
    return NextResponse.json({ success: true, productsSync: synced })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
