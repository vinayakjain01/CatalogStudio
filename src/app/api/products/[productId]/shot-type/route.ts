/**
 * PATCH /api/products/[productId]/shot-type
 *
 * Sets (or clears) the manual Product Positioning shot-type override for a
 * single product — the safety valve for when heuristic classification gets
 * it wrong (see src/lib/product-positioning.ts).
 *
 * Body: { shotTypeOverride: ShotType | null }
 *
 * Requires the products.shot_type_override column (text, nullable) to exist —
 * see docs/PROJECT_ARCHITECTURE.md / the Product Positioning plan for the
 * one-time manual `ALTER TABLE` step.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { SHOT_TYPES } from '@/types/template'

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ productId: string }> }
) {
  const { productId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { shotTypeOverride } = await request.json()
  if (shotTypeOverride !== null && !(SHOT_TYPES as string[]).includes(shotTypeOverride)) {
    return NextResponse.json({ error: 'Invalid shotTypeOverride' }, { status: 400 })
  }

  // Verify the product belongs to a store this user owns.
  const { data: product } = await supabase
    .from('products')
    .select('id, stores(user_id)')
    .eq('id', productId)
    .single()

  if (!product || (product as any).stores?.user_id !== user.id) {
    return NextResponse.json({ error: 'Product not found' }, { status: 404 })
  }

  const { error } = await supabase
    .from('products')
    .update({ shot_type_override: shotTypeOverride })
    .eq('id', productId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ shotTypeOverride })
}
