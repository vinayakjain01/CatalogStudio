/**
 * GET /api/catalog/status?importId=...
 * Returns progress and status of an import.
 *
 * POST /api/catalog/status
 * Body: { name: string }
 * Creates a new line-sheet "store" and returns its ID.
 * The caller then passes this store_id to /api/catalog/import.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getAdminClient } from '@/lib/generation-queue'

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const importId = request.nextUrl.searchParams.get('importId')
  const storeId  = request.nextUrl.searchParams.get('storeId')

  if (importId) {
    // Get single import status
    const { data } = await supabase
      .from('catalog_imports')
      .select('id, status, total_rows, imported_rows, failed_rows, filename, created_at, updated_at, error_report')
      .eq('id', importId)
      .single()

    if (!data) return NextResponse.json({ error: 'Import not found' }, { status: 404 })
    return NextResponse.json(data)
  }

  if (storeId) {
    // List all imports for a store
    const { data } = await supabase
      .from('catalog_imports')
      .select('id, status, total_rows, imported_rows, failed_rows, filename, created_at, updated_at')
      .eq('store_id', storeId)
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(20)

    return NextResponse.json({ imports: data || [] })
  }

  return NextResponse.json({ error: 'importId or storeId required' }, { status: 400 })
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { name } = await request.json()
  if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 })

  const admin = getAdminClient()

  // Create a line_sheet "store" — same table, different source
  const { data: store, error } = await admin
    .from('stores')
    .insert({
      user_id: user.id,
      shop_name: name,
      display_name: name,
      shop_domain: `linesheet-${Date.now()}`,  // unique placeholder
      source: 'line_sheet',
      is_active: true,
      feed_token: crypto.randomUUID(),
    })
    .select('id, shop_name')
    .single()

  if (error || !store) {
    return NextResponse.json({ error: error?.message || 'Failed to create catalog' }, { status: 500 })
  }

  return NextResponse.json({ storeId: store.id, name: store.shop_name })
}