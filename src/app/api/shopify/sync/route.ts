/**
 * POST /api/shopify/sync — manual re-sync trigger.  Body: { storeId }
 *
 * The spec's store-agnostic name for the existing per-store sync route. It
 * forwards so the token refresh, ownership check and needs_reauth handling stay
 * in one implementation.
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
