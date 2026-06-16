import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { getActiveStore } = await import('@/lib/active-store')
  const { activeStoreId } = await getActiveStore()
  const { data } = activeStoreId
    ? await supabase.from('template_categories').select('*')
        .eq('store_id', activeStoreId).order('name')
    : { data: [] }

  return NextResponse.json({ categories: data || [] })
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { name } = await request.json()
  if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 })

  const { getActiveStore } = await import('@/lib/active-store')
  const { activeStoreId } = await getActiveStore()
  if (!activeStoreId) return NextResponse.json({ error: 'No active store' }, { status: 400 })

  const { data, error } = await supabase
    .from('template_categories')
    .insert({ user_id: user.id, store_id: activeStoreId, name })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ category: data })
}