/**
 * POST /api/products/:productId/generate
 *
 * Path-param form of POST /api/generate/single, forwarded to that handler so
 * rate limiting, rule resolution and the compositor call stay in one place.
 *
 * Auth:    delegated to POST /api/generate/single — Supabase session
 *          (getUser()) + store ownership check
 * Rate:    delegated to POST /api/generate/single — 60 requests per user per hour
 * Body:    { storeId: string, variantId?: string, imageId?: string } —
 *          productId comes from the URL segment and is merged into the body
 *          before forwarding
 * Returns: same JSON as POST /api/generate/single — { generated: 1, url } or
 *          { generated: 0, message } when no rule matches
 *
 * Flow: read productId from params -> require storeId in body -> forward to generateSingle()
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
