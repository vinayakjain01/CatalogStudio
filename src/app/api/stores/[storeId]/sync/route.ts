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

/** True when the error is a Shopify 403 caused by a stale/non-expiring token. */
function isTokenError(err: any): boolean {
  const status = err?.response?.status
  if (status !== 403) return false
  const body = err?.response?.data
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? '')
  return (
    text.includes('Non-expiring access tokens') ||
    text.includes('offline-access-tokens') ||
    text.includes('token')
  )
}

/**
 * Turn an error into a useful message for the UI.
 * For Shopify/axios HTTP errors we expose the upstream status + body so the
 * real cause (e.g. invalid token, missing scope, suspended shop) is visible
 * instead of the opaque "Request failed with status code 403".
 */
function describeError(err: any): { message: string; status: number } {
  const httpStatus = err?.response?.status
  if (httpStatus) {
    const body = err.response?.data
    const detail =
      typeof body === 'string'
        ? body
        : body?.errors
          ? JSON.stringify(body.errors)
          : JSON.stringify(body ?? {})
    return {
      message: `Shopify API ${httpStatus}: ${detail || err.message}`,
      status: 502,
    }
  }
  return { message: err?.message ?? 'Sync failed', status: 500 }
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
      if (isTokenError(err)) {
        // Mark needs_reauth so the UI shows a Reconnect button
        await getAdminClient()
          .from('stores')
          .update({ needs_reauth: true })
          .eq('id', storeId)
      }
      const e = describeError(err)
      return NextResponse.json({ error: e.message, needs_reauth: isTokenError(err) }, { status: e.status })
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
    // Sync succeeded — clear any previous needs_reauth flag
    await adminSupabase
      .from('stores')
      .update({ needs_reauth: false })
      .eq('id', storeId)
    return NextResponse.json({ success: true, productsSync: synced })
  } catch (err: any) {
    if (isTokenError(err)) {
      // Token is stale — mark for reconnect
      await getAdminClient()
        .from('stores')
        .update({ needs_reauth: true })
        .eq('id', storeId)
    }
    const e = describeError(err)
    return NextResponse.json({ error: e.message, needs_reauth: isTokenError(err) }, { status: e.status })
  }
}