/**
 * GET /api/products/option-names?storeId=…
 *
 * Distinct Shopify option names (e.g. "Size", "Colour") in use across a
 * store's catalog — feeds the "Option name" suggestion list on the Generate
 * Creatives scope selector.
 *
 * Reads products.option{1,2,3}_name (migration 008). A store synced before
 * that migration has null names for every product, so this returns an empty
 * list rather than failing — the UI's Option name field is a free-text input
 * either way (see filterVariantsByOption's fallback in generation-queue.ts),
 * this endpoint only supplies autocomplete suggestions.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

const PAGE_SIZE = 1000

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const storeId = request.nextUrl.searchParams.get('storeId')
  if (!storeId) return NextResponse.json({ error: 'storeId required' }, { status: 400 })

  const { data: store } = await supabase
    .from('stores').select('id').eq('id', storeId).eq('user_id', user.id).single()
  if (!store) return NextResponse.json({ error: 'Store not found' }, { status: 404 })

  const names = new Set<string>()
  let from = 0

  // Paginated rather than one giant select: a store's product count can run
  // into the thousands, and only the DISTINCT names are needed, not the rows.
  while (true) {
    const { data, error } = await supabase
      .from('products')
      .select('option1_name, option2_name, option3_name')
      .eq('store_id', storeId)
      .range(from, from + PAGE_SIZE - 1)

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!data || data.length === 0) break

    for (const row of data) {
      for (const name of [row.option1_name, row.option2_name, row.option3_name]) {
        if (name && name.trim()) names.add(name.trim())
      }
    }

    if (data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }

  return NextResponse.json({
    names: Array.from(names).sort((a, b) => a.localeCompare(b)),
  })
}
