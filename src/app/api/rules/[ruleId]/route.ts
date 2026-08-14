import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

/**
 * PUT /api/rules/:id — update a rule.
 *
 * Field allow-list rather than spreading the body: template_rules holds
 * store_id and user_id, and a spread would let a caller reassign a rule to
 * another store or user.
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ ruleId: string }> }
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { ruleId } = await params
  const body = await request.json().catch(() => ({}))

  const patch: Record<string, unknown> = {}
  if (typeof body.name === 'string' || body.name === null) patch.name = body.name || null
  if (typeof body.template_id === 'string') patch.template_id = body.template_id
  if (Number.isFinite(body.priority)) patch.priority = Math.trunc(body.priority)
  if (typeof body.is_active === 'boolean') patch.is_active = body.is_active
  if (body.condition_mode === 'all' || body.condition_mode === 'any') {
    patch.condition_mode = body.condition_mode
  }

  if (Array.isArray(body.conditions)) {
    const conditions = body.conditions
      .map((c: any) => ({
        field: String(c?.field ?? ''),
        operator: String(c?.operator ?? 'is'),
        value: String(c?.value ?? ''),
      }))
      .filter((c: { field: string; value: string }) =>
        c.field && (c.value !== '' || c.field === 'all_products'))

    if (conditions.length === 0) {
      return NextResponse.json(
        { error: 'Every condition needs a field and a value' },
        { status: 400 }
      )
    }
    patch.conditions = conditions
    // Keep the deprecated NOT NULL columns satisfied — see the POST handler.
    patch.rule_type = 'conditions'
    patch.rule_operator = body.condition_mode === 'any' ? 'any' : 'all'
    patch.rule_value = ''
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'No updatable fields provided' }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('template_rules')
    .update(patch)
    .eq('id', ruleId)
    .eq('user_id', user.id)
    .select('*, templates(id, name)')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'Rule not found' }, { status: 404 })

  return NextResponse.json({ rule: data })
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ ruleId: string }> }
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { ruleId } = await params

  const { error } = await supabase
    .from('template_rules')
    .delete()
    .eq('id', ruleId)
    .eq('user_id', user.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}