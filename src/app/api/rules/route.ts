import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const storeId = request.nextUrl.searchParams.get('storeId')
  if (!storeId) return NextResponse.json({ error: 'storeId required' }, { status: 400 })

  const { data, error } = await supabase
    .from('template_rules')
    .select('*, templates(id, name)')
    .eq('user_id', user.id)
    .eq('store_id', storeId)
    // Ascending, and tie-broken by created_at, so this list is in the SAME order
    // the resolver evaluates. Listing them descending showed the merchant the
    // exact reverse of which rule actually wins.
    .order('priority', { ascending: true })
    .order('created_at', { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ rules: data })
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const {
    store_id, template_id, priority, name,
    conditions, condition_mode,          // v2 multi-condition
    rule_type, rule_operator, rule_value, // legacy single-condition
  } = body

  if (!store_id || !template_id) {
    return NextResponse.json({ error: 'store_id and template_id required' }, { status: 400 })
  }

  // Accept either shape. A v2 rule carries a conditions array; anything else is
  // treated as a legacy triple so older clients keep working.
  const isV2 = Array.isArray(conditions) && conditions.length > 0

  if (!isV2 && (!rule_type || !rule_operator || !rule_value)) {
    return NextResponse.json(
      { error: 'Provide conditions[], or rule_type/rule_operator/rule_value' },
      { status: 400 }
    )
  }

  let cleanConditions: { field: string; operator: string; value: string }[] = []
  if (isV2) {
    cleanConditions = conditions
      .map((c: any) => ({
        field: String(c?.field ?? ''),
        operator: String(c?.operator ?? 'is'),
        // all_products is a catch-all and legitimately carries no value.
        value: String(c?.value ?? ''),
      }))
      .filter((c: { field: string; value: string }) =>
        c.field && (c.value !== '' || c.field === 'all_products'))

    if (cleanConditions.length === 0) {
      return NextResponse.json(
        { error: 'Every condition needs a field and a value' },
        { status: 400 }
      )
    }
  }

  const { data, error } = await supabase
    .from('template_rules')
    .insert({
      user_id: user.id,
      store_id,
      template_id,
      name: name || null,
      conditions: cleanConditions,
      condition_mode: condition_mode === 'any' ? 'any' : 'all',
      // Legacy columns stay populated for legacy submissions so the resolver's
      // fallback path still has something to read.
      rule_type: isV2 ? null : rule_type,
      rule_operator: isV2 ? null : rule_operator,
      rule_value: isV2 ? null : rule_value,
      priority: priority ?? 0,
    })
    .select('*, templates(id, name)')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ rule: data })
}