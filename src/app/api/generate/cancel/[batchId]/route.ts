/**
 * POST /api/generate/cancel/:batchId — cancel a batch.
 *
 * Path-param form of the existing cancel endpoint, which takes { storeId,
 * batchId } in the body. storeId still comes from the body because cancelling
 * is ownership-checked against it.
 */
import { NextRequest, NextResponse } from 'next/server'
import { POST as cancelBatch } from '../route'

export const dynamic = 'force-dynamic'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ batchId: string }> }
) {
  const { batchId } = await params
  const body = await request.json().catch(() => ({}))
  if (!body?.storeId) {
    return NextResponse.json({ error: 'storeId required' }, { status: 400 })
  }

  return cancelBatch(new NextRequest(request.url, {
    method: 'POST',
    headers: request.headers,
    body: JSON.stringify({ ...body, batchId }),
  }))
}
