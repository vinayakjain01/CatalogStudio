/**
 * POST /api/image-extend
 * GET  /api/image-extend
 *
 * Trigger AI extend for a product image (used by builder live preview), or
 * check whether a cached result already exists without triggering AI
 * processing.
 *
 * Auth:    Supabase session cookie (supabase.auth.getUser()) + store
 *          ownership check (stores.user_id === user.id)
 * Body:    POST { imageUrl: string, targetWidth: number, targetHeight: number, storeId: string }
 * Query:   GET ?imageUrl=&targetWidth=&targetHeight=&storeId=
 * Returns: POST the result of getExtendedImage() (extended image data)
 *          GET  { cached: boolean, extendedUrl, provider, cachedAt }
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getAdminClient } from '@/lib/generation-queue'
import { getExtendedImage, getExtendCacheKey } from '@/lib/image-extend'

export const maxDuration = 60

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { imageUrl, targetWidth, targetHeight, storeId } = await request.json()
  if (!imageUrl)     return NextResponse.json({ error: 'imageUrl required' }, { status: 400 })
  if (!targetWidth)  return NextResponse.json({ error: 'targetWidth required' }, { status: 400 })
  if (!targetHeight) return NextResponse.json({ error: 'targetHeight required' }, { status: 400 })
  if (!storeId)      return NextResponse.json({ error: 'storeId required' }, { status: 400 })

  const { data: store } = await supabase
    .from('stores').select('id').eq('id', storeId).eq('user_id', user.id).single()
  if (!store) return NextResponse.json({ error: 'Store not found' }, { status: 404 })

  try {
    const admin = getAdminClient()
    const result = await getExtendedImage(imageUrl, targetWidth, targetHeight, storeId, admin)
    return NextResponse.json(result)
  } catch (err: any) {
    console.error('[api/image-extend] Error:', err.message)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const imageUrl    = request.nextUrl.searchParams.get('imageUrl')
  const targetWidth  = Number(request.nextUrl.searchParams.get('targetWidth'))
  const targetHeight = Number(request.nextUrl.searchParams.get('targetHeight'))
  const storeId     = request.nextUrl.searchParams.get('storeId')

  if (!imageUrl || !targetWidth || !targetHeight || !storeId) {
    return NextResponse.json({ error: 'imageUrl, targetWidth, targetHeight, storeId required' }, { status: 400 })
  }

  const admin = getAdminClient()
  const cacheKey = getExtendCacheKey(imageUrl, targetWidth, targetHeight)

  const { data: cached } = await admin
    .from('image_extend_cache')
    .select('extended_url, provider, created_at')
    .eq('cache_key', cacheKey)
    .maybeSingle()

  return NextResponse.json({
    cached: Boolean(cached),
    extendedUrl: cached?.extended_url || null,
    provider: cached?.provider || null,
    cachedAt: cached?.created_at || null,
  })
}