/**
 * GET /api/generate/status/:batchId — progress of one batch.
 *
 * The existing enqueue route already exposes this as ?batchId=…; this is the
 * path-param form from the spec, forwarded to the same handler so there is one
 * implementation of the counting logic.
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
