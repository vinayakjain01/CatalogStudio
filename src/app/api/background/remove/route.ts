/**
 * POST /api/background/remove
 * GET  /api/background/remove
 *
 * Auth: Supabase session cookie (supabase.auth.getUser()) on both methods
 *
 * POST — removes the background from a product image on demand (e.g. from the
 * product detail page); verifies storeId ownership
 *   Body:    { imageUrl: string, storeId: string }
 *   Returns: { transparentUrl, fromCache, provider }
 *
 * GET — check if a transparent version is already cached (no ownership check)
 *   Query:   imageUrl, storeId
 *   Returns: { cached, transparentUrl, provider, cachedAt }
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getAdminClient } from '@/lib/generation-queue'
import { getTransparentProductImage, getCacheKey } from '@/lib/background-removal'

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { imageUrl, storeId } = await request.json()
  if (!imageUrl) return NextResponse.json({ error: 'imageUrl required' }, { status: 400 })
  if (!storeId) return NextResponse.json({ error: 'storeId required' }, { status: 400 })

  // Verify store ownership
  const { data: store } = await supabase
    .from('stores').select('id').eq('id', storeId).eq('user_id', user.id).single()
  if (!store) return NextResponse.json({ error: 'Store not found' }, { status: 404 })

  try {
    const admin = getAdminClient()
    const result = await getTransparentProductImage(imageUrl, storeId, admin)
    return NextResponse.json(result)
  } catch (err: any) {
    console.error('[api/background/remove] Error:', err.message)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const imageUrl = request.nextUrl.searchParams.get('imageUrl')
  const storeId = request.nextUrl.searchParams.get('storeId')

  if (!imageUrl || !storeId) {
    return NextResponse.json({ error: 'imageUrl and storeId required' }, { status: 400 })
  }

  const admin = getAdminClient()
  const cacheKey = getCacheKey(imageUrl)

  const { data: cached } = await admin
    .from('bg_removal_cache')
    .select('transparent_url, provider, created_at')
    .eq('cache_key', cacheKey)
    .maybeSingle()

  return NextResponse.json({
    cached: Boolean(cached),
    transparentUrl: cached?.transparent_url || null,
    provider: cached?.provider || null,
    cachedAt: cached?.created_at || null,
  })
}