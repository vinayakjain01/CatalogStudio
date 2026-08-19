/**
 * POST /api/active-store
 *
 * Sets the caller's active store, persisted as an httpOnly cookie that other
 * routes (e.g. /api/categories) read back via getActiveStore(). Verifies the
 * user owns the store before persisting it.
 *
 * Auth:    Supabase session cookie (supabase.auth.getUser())
 * Body:    { storeId: string }
 * Returns: { success: true }, with ACTIVE_STORE_COOKIE set (1 year maxAge)
 *
 * Flow: authenticate -> validate storeId -> verify store.user_id === user.id -> set cookie
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { ACTIVE_STORE_COOKIE } from '@/lib/active-store'

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { storeId } = await request.json()
  if (!storeId) return NextResponse.json({ error: 'storeId required' }, { status: 400 })

  const { data: store } = await supabase
    .from('stores').select('id').eq('id', storeId).eq('user_id', user.id).single()
  if (!store) return NextResponse.json({ error: 'Store not found' }, { status: 404 })

  const res = NextResponse.json({ success: true })
  res.cookies.set(ACTIVE_STORE_COOKIE, storeId, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 365, // 1 year
  })
  return res
}