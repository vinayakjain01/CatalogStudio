import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getAdminClient } from '@/lib/generation-queue'
import { getCatalogQueue } from '@/lib/queues'

// Cancel all pending jobs for a batch (or the whole store if no batchId).
// Marks pending+processing rows as 'cancelled' in generation_jobs and removes
// matching BullMQ jobs from Redis so the worker never picks them up.
//
//   POST /api/generate/cancel  { storeId, batchId? }

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { storeId, batchId } = await request.json()
  if (!storeId) return NextResponse.json({ error: 'storeId required' }, { status: 400 })

  // Ownership check
  const { data: store } = await supabase
    .from('stores').select('id').eq('id', storeId).eq('user_id', user.id).single()
  if (!store) return NextResponse.json({ error: 'Store not found' }, { status: 404 })

  const admin = getAdminClient()

  // Find pending/processing jobs to cancel
  let query = admin
    .from('generation_jobs')
    .select('id')
    .eq('store_id', storeId)
    .in('status', ['pending', 'processing'])

  if (batchId) {
    query = query.eq('batch_id', batchId)
  }

  const { data: jobs, error: fetchError } = await query
  if (fetchError) return NextResponse.json({ error: fetchError.message }, { status: 500 })

  const jobIds = (jobs || []).map((j: any) => j.id)
  if (jobIds.length === 0) {
    return NextResponse.json({ cancelled: 0, message: 'No pending jobs to cancel' })
  }

  // Mark rows cancelled in DB
  const { error: updateError } = await admin
    .from('generation_jobs')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .in('id', jobIds)

  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 })

  console.log(`[cancel] Marked ${jobIds.length} jobs as cancelled in DB storeId=${storeId} batchId=${batchId ?? 'all'}`)

  // Best-effort: remove from BullMQ queue so the worker doesn't pick them up
  let removedFromRedis = 0
  try {
    const queue = getCatalogQueue('generation')
    if (queue) {
      await Promise.allSettled(
        jobIds.map(async (id: string) => {
          const bullJob = await queue.getJob(`generation:${id}`)
          if (bullJob) {
            const state = await bullJob.getState()
            // Only remove if waiting — active jobs are mid-flight and can't be safely removed
            if (state === 'waiting' || state === 'delayed') {
              await bullJob.remove()
              removedFromRedis++
            }
          }
        })
      )
      console.log(`[cancel] Removed ${removedFromRedis} jobs from Redis queue`)
    }
  } catch (err) {
    // Redis removal is best-effort: the DB status check in processGenerationJob
    // will skip cancelled rows even if they were already dequeued from Redis
    console.warn('[cancel] Redis job removal partial/failed (DB is source of truth):', err)
  }

  return NextResponse.json({
    cancelled: jobIds.length,
    removedFromRedis,
    message: `Cancelled ${jobIds.length} jobs`,
  })
}

// GET: check how many cancellable jobs exist for a batch/store
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const storeId = request.nextUrl.searchParams.get('storeId')
  const batchId = request.nextUrl.searchParams.get('batchId')

  if (!storeId) return NextResponse.json({ error: 'storeId required' }, { status: 400 })

  const { data: store } = await supabase
    .from('stores').select('id').eq('id', storeId).eq('user_id', user.id).single()
  if (!store) return NextResponse.json({ error: 'Store not found' }, { status: 404 })

  const admin = getAdminClient()
  let query = admin
    .from('generation_jobs')
    .select('status')
    .eq('store_id', storeId)
    .in('status', ['pending', 'processing'])

  if (batchId) query = query.eq('batch_id', batchId)

  const { data: jobs } = await query
  return NextResponse.json({ cancellable: (jobs || []).length })
}