/**
 * POST /api/product-layer/bundle
 * GET  /api/product-layer/bundle
 *
 * Triggers (or returns the cached) full product-layer asset bundle (cutout,
 * background plate, mask, pose/shot metadata) for a product image. Used by
 * the live editor hook use-product-layer-bundle.ts; GET is a cheap
 * cache-status preflight with no AI calls.
 *
 * Auth:    Supabase session cookie (supabase.auth.getUser()) + store
 *          ownership check (stores.user_id === user.id)
 * Body:    POST { imageUrl: string, storeId: string }
 * Query:   GET ?imageUrl=&storeId=
 * Returns: POST { transparentUrl, backgroundUrl, maskUrl, metadata, bundleStatus, fromCache, provider }
 *          GET  { isCached, bundleStatus, transparentUrl, backgroundUrl, metadata, cachedAt }
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getAdminClient } from '@/lib/generation-queue'
import { getProductLayerBundle } from '@/lib/product-layer-engine'
import { getCacheKey } from '@/lib/background-removal'

export const dynamic = 'force-dynamic'

// ─── POST — get or generate the full bundle ───────────────────────────────────

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { imageUrl?: string; storeId?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { imageUrl, storeId } = body
  if (!imageUrl) return NextResponse.json({ error: 'imageUrl required' }, { status: 400 })
  if (!storeId)  return NextResponse.json({ error: 'storeId required' },  { status: 400 })

  // Verify this store belongs to the authenticated user
  const { data: store } = await supabase
    .from('stores')
    .select('id')
    .eq('id', storeId)
    .eq('user_id', user.id)
    .single()
  if (!store) return NextResponse.json({ error: 'Store not found' }, { status: 404 })

  try {
    const admin  = getAdminClient()
    const bundle = await getProductLayerBundle(imageUrl, storeId, admin)

    return NextResponse.json({
      transparentUrl: bundle.transparentUrl,
      backgroundUrl:  bundle.backgroundUrl,
      maskUrl:        bundle.maskUrl,
      metadata:       bundle.metadata,
      bundleStatus:   bundle.bundleStatus,
      fromCache:      bundle.fromCache,
      provider:       bundle.provider,
    })
  } catch (err: any) {
    console.error('[api/product-layer/bundle] POST error:', err.message)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

// ─── GET — cheap cache-status check ──────────────────────────────────────────

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const imageUrl = request.nextUrl.searchParams.get('imageUrl')
  const storeId  = request.nextUrl.searchParams.get('storeId')
  if (!imageUrl || !storeId) {
    return NextResponse.json({ error: 'imageUrl and storeId required' }, { status: 400 })
  }

  const admin    = getAdminClient()
  const cacheKey = getCacheKey(imageUrl)

  const { data: cached } = await admin
    .from('bg_removal_cache')
    .select('transparent_url, background_url, metadata, bundle_status, provider, created_at')
    .eq('cache_key', cacheKey)
    .maybeSingle()

  return NextResponse.json({
    isCached:       Boolean(cached),
    bundleStatus:   cached?.bundle_status  ?? 'not_found',
    transparentUrl: cached?.transparent_url ?? null,
    backgroundUrl:  cached?.background_url  ?? null,
    metadata:       cached?.metadata        ?? null,
    cachedAt:       (cached as any)?.created_at ?? null,
  })
}