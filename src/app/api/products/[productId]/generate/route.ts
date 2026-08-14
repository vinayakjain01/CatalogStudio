/**
 * POST /api/products/:id/generate — generate one creative for this product.
 *
 * The spec's path-param form of /api/generate/single, forwarded to that handler
 * so rate limiting, rule resolution and the compositor call stay in one place.
 * Body still carries storeId, which that handler ownership-checks.
 */
import { NextRequest, NextResponse } from 'next/server'
import { POST as generateSingle } from '@/app/api/generate/single/route'

export const maxDuration = 300
export const dynamic = 'force-dynamic'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ productId: string }> }
) {
  const { productId } = await params
  const body = await request.json().catch(() => ({}))
  if (!body?.storeId) {
    return NextResponse.json({ error: 'storeId required' }, { status: 400 })
  }

  return generateSingle(new NextRequest(request.url, {
    method: 'POST',
    headers: request.headers,
    body: JSON.stringify({ ...body, productId }),
  }))
}
