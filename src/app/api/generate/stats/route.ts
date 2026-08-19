/**
 * GET /api/generate/stats?storeId=
 *
 * Coverage counters for the active store: how many active products match at
 * least one template rule, how many of those already have a completed
 * creative, and how many are still pending.
 *
 * Auth:    Supabase session cookie (supabase.auth.getUser()) + store
 *          ownership check (stores.user_id === user.id)
 * Query:   storeId (required)
 * Returns: { matched, generated, pending }
 *
 * Flow: verify user & store -> load active template rules -> page through
 * active products (1000 at a time) resolving each against the rules ->
 * count matched IDs that already have a completed generated_images row.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getAdminClient } from '@/lib/generation-queue'
import { resolveTemplateFromRules, getActiveTemplateRules } from '@/lib/template-resolver'

// Returns, for the active store:
//   matched   = products that match at least one rule
//   generated = of those, how many already have a completed creative
//   pending   = matched − generated
//
//   GET /api/generate/stats?storeId=...
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

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

  // Load the store's rules once.
  const rules = await getActiveTemplateRules(storeId)
  if (!rules || rules.length === 0) {
    return NextResponse.json({ matched: 0, generated: 0, pending: 0 })
  }

  // Page through products, count those that match a rule.
  const PAGE = 1000
  let fromRow = 0
  const matchedIds: string[] = []
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data: products } = await admin
      .from('products')
      .select('id, tags, vendor, product_type, price, compare_at_price')
      .eq('store_id', storeId)
      .eq('status', 'active')
      .range(fromRow, fromRow + PAGE - 1)

    if (!products || products.length === 0) break
    for (const p of products as any[]) {
      const tpl = resolveTemplateFromRules(
        {
          id: p.id,
          tags: p.tags || [],
          vendor: p.vendor,
          product_type: p.product_type,
          price: p.price,
          compare_at_price: p.compare_at_price,
        },
        rules
      )
      if (tpl) matchedIds.push(p.id)
    }
    if (products.length < PAGE) break
    fromRow += PAGE
  }

  const matched = matchedIds.length

  // Of the matched products, how many already have a completed creative.
  let generated = 0
  for (let i = 0; i < matchedIds.length; i += 1000) {
    const chunk = matchedIds.slice(i, i + 1000)
    const { data: done } = await admin
      .from('generated_images')
      .select('product_id')
      .in('product_id', chunk)
      .eq('status', 'completed')
    const uniq = new Set((done || []).map((d: any) => d.product_id))
    generated += uniq.size
  }

  return NextResponse.json({ matched, generated, pending: Math.max(0, matched - generated) })
}