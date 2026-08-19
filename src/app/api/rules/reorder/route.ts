/**
 * PUT /api/rules/reorder
 *
 * Set rule priorities in one call — reorders a store's automation rules.
 *
 * Auth:    Supabase session cookie; storeId must belong to the signed-in user;
 *          only ruleIds already belonging to that store are applied.
 * Body:    { storeId, ruleIds: string[] } — array order IS the new priority,
 *          index 0 evaluated first, matching the v2 "lower number wins" semantics.
 * Returns: { reordered: number, ruleIds: string[] } (ids actually applied), or
 *          on a mid-way failure { error, appliedUpTo, applied }.
 *
 * Takes the whole ordering rather than a single moved rule so a drag-reorder
 * cannot leave two rules sharing a priority, where which one wins would depend
 * on the created_at tie-break instead of the user's intent.
 *
 * NOTE: applied as sequential updates, not a transaction — PostgREST has no
 * multi-statement transaction. A failure mid-way is reported with the index
 * reached, so the caller can retry the same array idempotently.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export async function PUT(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { storeId, ruleIds } = await request.json().catch(() => ({}))
  if (!storeId || !Array.isArray(ruleIds) || ruleIds.length === 0) {
    return NextResponse.json({ error: 'storeId and ruleIds[] required' }, { status: 400 })
  }

  const { data: store } = await supabase
    .from('stores').select('id').eq('id', storeId).eq('user_id', user.id).single()
  if (!store) return NextResponse.json({ error: 'Store not found' }, { status: 404 })

  // Only reorder rules that actually belong to this store — an id from another
  // store must not have its priority rewritten.
  const { data: owned } = await supabase
    .from('template_rules').select('id').eq('store_id', storeId)
  const ownedIds = new Set((owned ?? []).map(r => r.id))

  const applied: string[] = []
  for (let i = 0; i < ruleIds.length; i++) {
    const id = ruleIds[i]
    if (!ownedIds.has(id)) continue
    const { error } = await supabase
      .from('template_rules').update({ priority: i }).eq('id', id).eq('store_id', storeId)
    if (error) {
      return NextResponse.json(
        { error: error.message, appliedUpTo: i, applied },
        { status: 500 }
      )
    }
    applied.push(id)
  }

  return NextResponse.json({ reordered: applied.length, ruleIds: applied })
}
