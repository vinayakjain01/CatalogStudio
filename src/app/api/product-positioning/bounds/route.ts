/**
 * GET /api/product-positioning/bounds?imageUrl=...&storeId=...
 *
 * Returns the product's pixel bounding box (ProductBounds) for an image —
 * fetched ONCE per image by the template builder, which then runs all
 * classification + placement math client-side (product-positioning-shared.ts)
 * on every slider change with zero further API calls. Bounds detection itself
 * needs @napi-rs/canvas (Node-only), which is the only reason this round-trip
 * exists at all.
 *
 * No server-side cache table: this is a ~1-3ms pixel scan plus one image
 * fetch (served from the compositor-style HTTP cache), not a metered AI call.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { detectProductBounds } from '@/lib/image-bounds'

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const imageUrl = request.nextUrl.searchParams.get('imageUrl')
  const storeId = request.nextUrl.searchParams.get('storeId')
  if (!imageUrl || !storeId) {
    return NextResponse.json({ error: 'imageUrl and storeId required' }, { status: 400 })
  }

  // Verify store ownership
  const { data: store } = await supabase
    .from('stores').select('id').eq('id', storeId).eq('user_id', user.id).single()
  if (!store) return NextResponse.json({ error: 'Store not found' }, { status: 404 })

  try {
    const bounds = await detectProductBounds(imageUrl)
    return NextResponse.json({ bounds })
  } catch (err: any) {
    console.error('[api/product-positioning/bounds] Error:', err.message)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
