import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

/**
 * List generation jobs for a store (most recent first). Joins product title and
 * template name for display. RLS scopes rows to the authenticated user.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const storeId = request.nextUrl.searchParams.get('storeId')
  const limit = Number(request.nextUrl.searchParams.get('limit') ?? 100)

  let query = supabase
    .from('generation_jobs')
    .select('id, store_id, product_id, template_id, status, progress, error, created_at, started_at, completed_at, products(title), templates(name)')
    .order('created_at', { ascending: false })
    .limit(Math.min(limit, 500))

  if (storeId) query = query.eq('store_id', storeId)

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ jobs: data })
}
