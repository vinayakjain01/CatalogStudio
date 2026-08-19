/**
 * POST /api/shopify/sync
 *
 * The spec's store-agnostic name for the existing per-store sync route. It
 * forwards so the token refresh, ownership check and needs_reauth handling stay
 * in one implementation.
 *
 * Auth:     none directly — delegates to POST /api/stores/[storeId]/sync, which
 *           checks the Supabase session (or an internal x-internal-secret header)
 * Body:     { storeId: string }
 * Returns:  whatever the forwarded route returns — { success: true, productsSync }
 *           on success, or { error, needs_reauth } on failure
 *
 * Flow: read storeId from body -> re-issue as a NextRequest to the per-store sync route handler
 */
import { NextRequest, NextResponse } from 'next/server'
import { POST as syncStore } from '@/app/api/stores/[storeId]/sync/route'

export const maxDuration = 300
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}))
  const storeId = body?.storeId
  if (!storeId) {
    return NextResponse.json({ error: 'storeId required' }, { status: 400 })
  }

  return syncStore(
    new NextRequest(request.url, { method: 'POST', headers: request.headers }),
    { params: Promise.resolve({ storeId }) }
  )
}
