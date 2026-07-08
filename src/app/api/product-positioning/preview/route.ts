/**
 * POST /api/product-positioning/preview
 *
 * Live-preview endpoint for the template builder's Product Positioning panel.
 * Bounds detection requires @napi-rs/canvas (Node-only), so this can't run in
 * the browser — but unlike background-removal/image-extend, there's no
 * external AI cost here, just a ~1-3ms pixel scan plus pure math, so there's
 * no server-side cache table and no GET/cache-check variant.
 *
 * Body: { imageUrl, canvasWidth, canvasHeight, settings, manualShotTypeOverride?, storeId }
 * Returns: ResolvePositioningResult ({ apply, shotType, placement, wouldCrop })
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveProductPositioning } from '@/lib/product-positioning'

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { imageUrl, canvasWidth, canvasHeight, settings, manualShotTypeOverride, storeId } = await request.json()

  if (!imageUrl || !canvasWidth || !canvasHeight || !settings || !storeId) {
    return NextResponse.json(
      { error: 'imageUrl, canvasWidth, canvasHeight, settings and storeId are required' },
      { status: 400 }
    )
  }

  // Verify store ownership
  const { data: store } = await supabase
    .from('stores').select('id').eq('id', storeId).eq('user_id', user.id).single()
  if (!store) return NextResponse.json({ error: 'Store not found' }, { status: 404 })

  try {
    const result = await resolveProductPositioning(
      imageUrl, canvasWidth, canvasHeight, settings, manualShotTypeOverride ?? null
    )
    return NextResponse.json(result)
  } catch (err: any) {
    console.error('[api/product-positioning/preview] Error:', err.message)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
