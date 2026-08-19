/**
 * GET /api/shopify/sync/status
 *
 * Reports the newest sync_logs row plus current catalog counts, so a caller can
 * tell "running" from "finished" and see what actually landed. Counts come from
 * the tables themselves rather than the log, because a run that dies partway
 * still writes rows and the log alone would understate them.
 *
 * Auth:     Supabase session cookie (supabase.auth.getUser()); the store must belong to the user
 * Query:    storeId (required)
 * Returns:  { storeId, status, lastSyncedAt, needsReauth, lastRun, counts: { products, variants, images } }
 *
 * Flow: verify session -> load store scoped to user -> fetch latest sync_logs row and live table counts in parallel -> merge into response
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const storeId = request.nextUrl.searchParams.get('storeId')
  if (!storeId) return NextResponse.json({ error: 'storeId required' }, { status: 400 })

  const { data: store } = await supabase
    .from('stores')
    .select('id, last_synced_at, sync_status, needs_reauth')
    .eq('id', storeId)
    .eq('user_id', user.id)
    .single()

  if (!store) return NextResponse.json({ error: 'Store not found' }, { status: 404 })

  const [{ data: log }, products, variants, images] = await Promise.all([
    supabase
      .from('sync_logs')
      .select('status, sync_type, products_synced, error_message, started_at, completed_at')
      .eq('store_id', storeId)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase.from('products').select('id', { count: 'exact', head: true }).eq('store_id', storeId),
    supabase.from('product_variants').select('id', { count: 'exact', head: true }).eq('store_id', storeId),
    supabase
      .from('product_images')
      .select('id, products!inner(store_id)', { count: 'exact', head: true })
      .eq('products.store_id', storeId),
  ])

  return NextResponse.json({
    storeId,
    // 'running' only while the newest log says so — a completed log means idle
    // even if stores.sync_status was never updated.
    status: log?.status === 'running' ? 'running' : (store.sync_status ?? 'idle'),
    lastSyncedAt: store.last_synced_at,
    needsReauth: store.needs_reauth ?? false,
    lastRun: log ?? null,
    counts: {
      products: products.count ?? 0,
      variants: variants.count ?? 0,
      images: images.count ?? 0,
    },
  })
}
