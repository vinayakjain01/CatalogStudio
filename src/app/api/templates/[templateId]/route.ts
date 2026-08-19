/**
 * GET /api/templates/[templateId]
 * PUT /api/templates/[templateId]
 * DELETE /api/templates/[templateId]
 *
 * Fetch, update, or delete a single template owned by the current user.
 *
 * Auth:     Supabase session cookie (supabase.auth.getUser()); every query is
 *           scoped by both id and user_id so a user cannot touch another user's template
 * Body:     PUT — arbitrary partial template fields from request.json(), saved
 *           along with a refreshed updated_at timestamp
 * Returns:  GET/PUT -> { template }; DELETE -> { success: true }; errors -> { error }
 *
 * Flow: verify session -> query/mutate scoped to templateId + user_id -> return result
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ templateId: string }> }
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { templateId } = await params

  const { data, error } = await supabase
    .from('templates')
    .select('*')
    .eq('id', templateId)
    .eq('user_id', user.id)
    .single()

  if (error || !data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ template: data })
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ templateId: string }> }
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { templateId } = await params
  const body = await request.json()

  const { data, error } = await supabase
    .from('templates')
    .update({ ...body, updated_at: new Date().toISOString() })
    .eq('id', templateId)
    .eq('user_id', user.id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ template: data })
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ templateId: string }> }
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { templateId } = await params

  const { error } = await supabase
    .from('templates')
    .delete()
    .eq('id', templateId)
    .eq('user_id', user.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}