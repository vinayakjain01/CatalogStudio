import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getAdminClient, enqueueGeneration } from '@/lib/generation-queue'
import { isRedisEnabled } from '@/lib/redis'
import { randomUUID } from 'crypto'

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { storeId, filter, creativeType } = await request.json()
  if (!storeId) return NextResponse.json({ error: 'storeId required' }, { status: 400 })

  const { data: store } = await supabase
    .from('stores').select('id').eq('id', storeId).eq('user_id', user.id).single()
  if (!store) return NextResponse.json({ error: 'Store not found' }, { status: 404 })

  const admin = getAdminClient()
  const productIds: string[] = []
  const PAGE = 1000
  let from = 0

  while (true) {
    let q = admin
      .from('products')
      .select('id')
      .eq('store_id', storeId)
      .eq('status', 'active')
      .range(from, from + PAGE - 1)

    if (filter?.type === 'tag' && filter.value) q = q.contains('tags', [filter.value])
    else if (filter?.type === 'vendor' && filter.value) q = q.eq('vendor', filter.value)
    else if (filter?.type === 'product_type' && filter.value) q = q.eq('product_type', filter.value)

    const { data: products, error } = await q
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!products || products.length === 0) break
    productIds.push(...products.map((p: any) => p.id))
    if (products.length < PAGE) break
    from += PAGE
  }

  if (productIds.length === 0) {
    return NextResponse.json({ message: 'No products matched', enqueued: 0 })
  }

  const batchId = randomUUID()
  const enqueued = await enqueueGeneration(
    { storeId, productIds, creativeType: creativeType || 'default', batchId },
    admin
  )

  // Tell the client whether the DO worker will handle this (Redis path)
  // or whether the client needs to drive drain calls (no-Redis fallback)
  const redisEnabled = isRedisEnabled()
  console.log(`[enqueue] batchId=${batchId} enqueued=${enqueued} redisEnabled=${redisEnabled}`)

  return NextResponse.json({ batchId, enqueued, redisEnabled })
}

// Progress polling
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const batchId = request.nextUrl.searchParams.get('batchId')
  if (!batchId) return NextResponse.json({ error: 'batchId required' }, { status: 400 })

  const admin = getAdminClient()
  const { data: jobs } = await admin
    .from('generation_jobs')
    .select('status')
    .eq('batch_id', batchId)

  const counts = { pending: 0, processing: 0, completed: 0, failed: 0, cancelled: 0, total: jobs?.length || 0 }
  for (const j of jobs || []) (counts as any)[j.status] = ((counts as any)[j.status] || 0) + 1

  return NextResponse.json(counts)
}