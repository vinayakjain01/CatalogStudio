/**
 * GET  /api/generate/cancel
 * POST /api/generate/cancel
 *
 * Cancel (or count) pending/processing generation jobs for a batch, or for
 * the whole store when no batchId is given.
 *
 * Auth:    Supabase session cookie (createClient().auth.getUser()) + store
 *          ownership check (stores.user_id === user.id)
 * Body:    POST { storeId: string, batchId?: string }
 * Query:   GET ?storeId=&batchId=
 * Returns: POST { deleted, cancelled, removedFromRedis, message } (or an
 *          early { deleted: 0, cancelled: 0, message } when nothing matched)
 *          GET  { cancellable: number }
 *
 * Flow (POST): verify user & store -> find pending/processing jobs -> delete
 * pending rows outright, mark processing rows 'cancelled' -> best-effort
 * remove still-waiting jobs from the BullMQ queue -> return counts.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getAdminClient } from '@/lib/generation-queue'
import { getCatalogQueue } from '@/lib/queues'

/**
 * Cancel all pending/processing jobs for a batch (or the whole store if no
 * batchId).
 *
 * PENDING rows are DELETED outright, not soft-cancelled. A job that hasn't
 * started never gets claimed either way — the existing claim query in
 * processGenerationJob/processBatch already requires `status = 'pending'` —
 * but deleting is the more literal "stop generating this" than leaving
 * thousands of 'cancelled' rows behind, and it shrinks the batch's own
 * progress-poll total immediately instead of it staying stuck at the
 * original job count.
 *
 * PROCESSING rows are marked 'cancelled', not deleted — the row is mid-flight
 * (a worker has already claimed it and is compositing/uploading), and
 * deleting it out from under that in-flight write risks an FK error when the
 * job finishes and tries to write generation_jobs.updated_at or reference its
 * own id. runJob() re-checks this status before its Cloudinary upload and
 * again before its final 'completed' write (see generation-queue.ts) — the
 * in-flight render can't be aborted, but its result is discarded rather than
 * recorded, and the row stays correctly 'cancelled' instead of being
 * overwritten back to 'completed'.
 *
 *   POST /api/generate/cancel  { storeId, batchId? }
 */
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
    .select('id, status')
    .eq('store_id', storeId)
    .in('status', ['pending', 'processing'])

  if (batchId) {
    query = query.eq('batch_id', batchId)
  }

  const { data: jobs, error: fetchError } = await query
  if (fetchError) return NextResponse.json({ error: fetchError.message }, { status: 500 })

  if (!jobs || jobs.length === 0) {
    return NextResponse.json({ deleted: 0, cancelled: 0, message: 'No pending jobs to cancel' })
  }

  const pendingIds = jobs.filter(j => j.status === 'pending').map(j => j.id)
  const processingIds = jobs.filter(j => j.status === 'processing').map(j => j.id)

  // Supabase's query builders are PromiseLike, not strict Promise instances
  // (they implement .then() but not .catch()/.finally()), so Promise.all's
  // input type has to be this loose to accept them directly.
  const ops: PromiseLike<{ error: { message: string } | null }>[] = []

  if (pendingIds.length > 0) {
    ops.push(admin.from('generation_jobs').delete().in('id', pendingIds))
  }
  if (processingIds.length > 0) {
    ops.push(
      admin.from('generation_jobs')
        .update({ status: 'cancelled', updated_at: new Date().toISOString() })
        .in('id', processingIds)
    )
  }

  const results = await Promise.all(ops)
  const failedOp = results.find(r => r.error)
  if (failedOp?.error) {
    return NextResponse.json({ error: failedOp.error.message }, { status: 500 })
  }

  console.log(
    `[cancel] deleted=${pendingIds.length} pending, cancelled=${processingIds.length} processing ` +
    `storeId=${storeId} batchId=${batchId ?? 'all'}`
  )

  // Best-effort: remove PENDING jobs from the BullMQ queue so a worker that
  // hasn't picked one up yet doesn't call processGenerationJob for a row
  // that's already gone. Jobs already 'active' in BullMQ correspond to the
  // 'processing' DB rows above and can't be pulled back — same limit as before.
  let removedFromRedis = 0
  if (pendingIds.length > 0) {
    try {
      const queue = getCatalogQueue('generation')
      if (queue) {
        await Promise.allSettled(
          pendingIds.map(async (id: string) => {
            const bullJob = await queue.getJob(`generation:${id}`)
            if (bullJob) {
              const state = await bullJob.getState()
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
      // Redis removal is best-effort: deleting the DB row is what actually
      // stops generation — a leftover Redis entry just wastes one no-op claim
      // attempt when the worker gets to it.
      console.warn('[cancel] Redis job removal partial/failed (DB is source of truth):', err)
    }
  }

  return NextResponse.json({
    deleted: pendingIds.length,
    cancelled: processingIds.length,
    removedFromRedis,
    message: `Stopped: ${pendingIds.length} pending jobs deleted, ${processingIds.length} in-progress jobs cancelled.`,
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
