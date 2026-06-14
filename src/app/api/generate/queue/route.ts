import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createSupabaseAdmin } from '@supabase/supabase-js'
import { getGenerationQueue } from '@/lib/queue/queues'
import { runGenerationInline } from '@/lib/generation/process'

function getAdminClient() {
  return createSupabaseAdmin(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

interface EnqueueBody {
  storeId: string
  productIds?: string[]
  filter?: { type: 'all' | 'tag' | 'vendor' | 'product_type'; value?: string }
}

/**
 * Enqueue creative generation for a set of products. Accepts either explicit
 * `productIds` or a `filter`. Creates one generation_jobs row per product, then
 * either pushes to the BullMQ queue (when Redis is configured) or processes
 * inline (fire-and-forget) as a fallback.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = (await request.json()) as EnqueueBody
  const { storeId, productIds, filter } = body
  if (!storeId) return NextResponse.json({ error: 'storeId required' }, { status: 400 })

  // Verify store ownership.
  const { data: store } = await supabase
    .from('stores')
    .select('id')
    .eq('id', storeId)
    .eq('user_id', user.id)
    .single()
  if (!store) return NextResponse.json({ error: 'Store not found' }, { status: 404 })

  const admin = getAdminClient()

  // Resolve the target product ids.
  let ids: string[] = []
  if (productIds && productIds.length > 0) {
    ids = productIds
  } else {
    let q = admin.from('products').select('id').eq('store_id', storeId).eq('status', 'active')
    if (filter?.type === 'tag' && filter.value) q = q.contains('tags', [filter.value])
    else if (filter?.type === 'vendor' && filter.value) q = q.eq('vendor', filter.value)
    else if (filter?.type === 'product_type' && filter.value) q = q.eq('product_type', filter.value)
    const { data } = await q.limit(1000)
    ids = (data || []).map((p) => p.id as string)
  }

  if (ids.length === 0) {
    return NextResponse.json({ message: 'No products matched', enqueued: 0 })
  }

  // Create job rows (status 'queued').
  const { data: jobs, error: jobErr } = await admin
    .from('generation_jobs')
    .insert(
      ids.map((productId) => ({
        user_id: user.id,
        store_id: storeId,
        product_id: productId,
        status: 'queued',
        progress: 0,
      }))
    )
    .select('id, product_id')

  if (jobErr || !jobs) {
    return NextResponse.json({ error: jobErr?.message || 'Failed to create jobs' }, { status: 500 })
  }

  const queue = getGenerationQueue()

  if (queue) {
    await queue.addBulk(
      jobs.map((j) => ({
        name: 'generate',
        data: { jobId: j.id as string, productId: j.product_id as string, storeId },
      }))
    )
    return NextResponse.json({ enqueued: jobs.length, mode: 'queue' })
  }

  // Inline fallback (no Redis): process without blocking the response.
  void Promise.allSettled(
    jobs.map((j) =>
      runGenerationInline({ jobId: j.id as string, productId: j.product_id as string, storeId })
    )
  )
  return NextResponse.json({ enqueued: jobs.length, mode: 'inline' })
}
