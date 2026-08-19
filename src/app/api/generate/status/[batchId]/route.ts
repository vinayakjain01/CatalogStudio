/**
 * GET /api/generate/status/:batchId
 *
 * Path-param form of GET /api/generate/enqueue?batchId=…, forwarded to the
 * same handler so there is one implementation of the counting logic.
 *
 * Auth:    delegated to GET /api/generate/enqueue (Supabase session, getUser())
 * Returns: same JSON as GET /api/generate/enqueue — { pending, processing,
 *          completed, failed, cancelled, total }
 *
 * Flow: read batchId from params -> set it as the ?batchId query param -> forward to the enqueue route's GET handler.
 */
import { NextRequest } from 'next/server'
import { GET as batchStatus } from '../../enqueue/route'

export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ batchId: string }> }
) {
  const { batchId } = await params
  const url = new URL(request.url)
  url.searchParams.set('batchId', batchId)
  return batchStatus(new NextRequest(url, request))
}
