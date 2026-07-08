/**
 * POST /api/background-reconstruction
 * Reconstructs a product photo's original background (product region
 * AI-inpainted) on demand — used by the template builder's live preview when
 * a template opts into backgroundSettings.mode === 'original'.
 *
 * Body: { imageUrl: string, transparentUrl: string, storeId: string }
 * Returns: { backgroundUrl, fromCache } | { backgroundUrl: null, fromCache: false }
 *
 * GET /api/background-reconstruction?imageUrl=...&storeId=...
 * Check if a reconstructed background is already cached (cheap, no AI call).
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getAdminClient } from '@/lib/generation-queue'
import { getReconstructedBackground, getReconstructionCacheKey } from '@/lib/background-reconstruction'

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { imageUrl, transparentUrl, storeId } = await request.json()
  if (!imageUrl) return NextResponse.json({ error: 'imageUrl required' }, { status: 400 })
  if (!transparentUrl) return NextResponse.json({ error: 'transparentUrl required' }, { status: 400 })
  if (!storeId) return NextResponse.json({ error: 'storeId required' }, { status: 400 })

  // Verify store ownership
  const { data: store } = await supabase
    .from('stores').select('id').eq('id', storeId).eq('user_id', user.id).single()
  if (!store) return NextResponse.json({ error: 'Store not found' }, { status: 404 })

  const admin = getAdminClient()
  const result = await getReconstructedBackground(imageUrl, transparentUrl, storeId, admin)

  return NextResponse.json({
    backgroundUrl: result.backgroundUrl,
    fromCache: result.fromCache,
    error: result.error,
  })
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
  const cacheKey = getReconstructionCacheKey(imageUrl)

  const { data: cached } = await admin
    .from('background_reconstruction_cache')
    .select('background_url, created_at')
    .eq('cache_key', cacheKey)
    .maybeSingle()

  return NextResponse.json({
    cached: Boolean(cached),
    backgroundUrl: cached?.background_url || null,
    cachedAt: cached?.created_at || null,
  })
}
