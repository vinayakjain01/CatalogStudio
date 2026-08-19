/**
 * GET /api/product-positioning/bounds?imageUrl=...&storeId=...&mode=zoom
 *
 * Returns the product's pixel bounding box (ProductBounds) for an image —
 * fetched ONCE per image by the template builder, which then runs all
 * classification + placement math client-side (product-positioning-shared.ts)
 * on every slider change with zero further API calls. Bounds detection itself
 * needs @napi-rs/canvas (Node-only), which is the only reason this round-trip
 * exists at all.
 *
 * `mode` is optional and defaults to the original alpha-channel detector
 * (Standard Mode's Head Space preview). Pass `mode=zoom` for Product Zoom
 * Mode's live preview, which needs detectZoomSubjectBounds() (backdrop-
 * contrast detection) instead, since its input photos are always opaque.
 *
 * No server-side cache table: this is a ~1-3ms pixel scan plus one image
 * fetch (served from the compositor-style HTTP cache), not a metered AI call.
 *
 * Auth:    Supabase session cookie (supabase.auth.getUser()) + store
 *          ownership check (stores.user_id === user.id)
 * Query:   imageUrl (required), storeId (required), mode ('zoom' | omitted)
 * Returns: { bounds: ProductBounds }
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { detectProductBounds, detectZoomSubjectBounds } from '@/lib/image-bounds'

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const imageUrl = request.nextUrl.searchParams.get('imageUrl')
  const storeId = request.nextUrl.searchParams.get('storeId')
  const mode = request.nextUrl.searchParams.get('mode')
  if (!imageUrl || !storeId) {
    return NextResponse.json({ error: 'imageUrl and storeId required' }, { status: 400 })
  }

  // Verify store ownership
  const { data: store } = await supabase
    .from('stores').select('id').eq('id', storeId).eq('user_id', user.id).single()
  if (!store) return NextResponse.json({ error: 'Store not found' }, { status: 404 })

  try {
    const bounds = mode === 'zoom'
      ? await detectZoomSubjectBounds(imageUrl)
      : await detectProductBounds(imageUrl)
    return NextResponse.json({ bounds })
  } catch (err: any) {
    console.error('[api/product-positioning/bounds] Error:', err.message)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
