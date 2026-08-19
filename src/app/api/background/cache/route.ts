/**
 * DELETE /api/background/cache
 * GET    /api/background/cache
 *
 * Auth: Supabase session cookie (supabase.auth.getUser()); storeId ownership
 *       verified on both methods
 *
 * DELETE — invalidate a cached background removal result (forces re-processing)
 *   Body:    { imageUrl: string, storeId: string }
 *   Returns: { success: true, message: 'Cache invalidated' }
 *
 * GET — list cached bg-removal entries for a store (most recent 50)
 *   Query:   storeId
 *   Returns: { entries: [...], total }
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getAdminClient } from '@/lib/generation-queue'
import { invalidateBgRemovalCache } from '@/lib/background-removal'

export async function DELETE(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { imageUrl, storeId } = await request.json()
  if (!imageUrl || !storeId) {
    return NextResponse.json({ error: 'imageUrl and storeId required' }, { status: 400 })
  }

  const { data: store } = await supabase
    .from('stores').select('id').eq('id', storeId).eq('user_id', user.id).single()
  if (!store) return NextResponse.json({ error: 'Store not found' }, { status: 404 })

  const admin = getAdminClient()
  await invalidateBgRemovalCache(imageUrl, admin)

  return NextResponse.json({ success: true, message: 'Cache invalidated' })
}

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const storeId = request.nextUrl.searchParams.get('storeId')
  if (!storeId) return NextResponse.json({ error: 'storeId required' }, { status: 400 })

  const { data: store } = await supabase
    .from('stores').select('id').eq('id', storeId).eq('user_id', user.id).single()
  if (!store) return NextResponse.json({ error: 'Store not found' }, { status: 404 })

  const admin = getAdminClient()
  const { data: entries, count } = await admin
    .from('bg_removal_cache')
    .select('id, source_url, transparent_url, provider, created_at', { count: 'exact' })
    .eq('store_id', storeId)
    .order('created_at', { ascending: false })
    .limit(50)

  return NextResponse.json({ entries: entries || [], total: count || 0 })
}