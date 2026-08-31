/**
 * GET  /api/generate/enqueue?batchId=
 * POST /api/generate/enqueue
 *
 * Bulk-enqueues generation jobs for a filtered set of products/variants/images,
 * and reports live per-batch job counts for the Creatives page progress bar.
 *
 * Auth:    Supabase session (getUser())
 * Rate:    POST only — rateLimit(`bulk:${storeId}`), 5 requests per store per
 *          hour (BULK_RATE_LIMIT_PER_STORE / BULK_RATE_WINDOW_SECS)
 * Body:    POST { storeId, filter?, creativeType?, variantScope?, variantOption?, imageScope?,
 *          assetTypes? } — assetTypes defaults to ['catalog']; invalid values are dropped,
 *          and an empty result after that is a 400
 * Query:   GET ?batchId=
 * Returns: GET  { pending, processing, completed, failed, cancelled, skipped, total }
 *          POST { batchId, enqueued, redisEnabled, priority } on success, or
 *          { message, enqueued: 0 } when nothing matched
 *
 * Flow (POST): verify user -> validate scope -> verify store ownership ->
 * rate limit -> enforce MAX_PENDING_JOBS_PER_STORE queue cap -> collect
 * matching product IDs -> compute fair priority -> enqueueGeneration().
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getUser } from '@/lib/supabase/get-user'
import { getAdminClient, enqueueGeneration, collectFilteredProductIds } from '@/lib/generation-queue'
import { isRedisEnabled } from '@/lib/redis'
import { rateLimit, rateLimitHeaders } from '@/lib/rate-limit'
import { randomUUID } from 'crypto'
import { ALL_ASSET_TYPES, type AssetType } from '@/types/template'

// ── Limits ────────────────────────────────────────────────────────────────────

/**
 * GET /api/generate/enqueue?batchId=xxx
 * Returns live job counts for the progress bar in the Creatives page.
 * Called every 2 seconds while generation is running.
 */
export async function GET(request: NextRequest) {
  const user = await getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const batchId = request.nextUrl.searchParams.get('batchId')
  if (!batchId) return NextResponse.json({ error: 'batchId required' }, { status: 400 })

  const admin = getAdminClient()
  const { data: jobs, error } = await admin
    .from('generation_jobs')
    .select('id, status')
    .eq('batch_id', batchId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const counts = { pending: 0, processing: 0, completed: 0, failed: 0, cancelled: 0, skipped: 0, total: 0 }
  for (const job of jobs || []) {
    counts.total++
    const s = job.status as keyof typeof counts
    if (s in counts) counts[s]++
  }

  return NextResponse.json(counts)
}

// Tune these based on your worker capacity and team size.
const BULK_RATE_LIMIT_PER_STORE = 5      // max 5 bulk batches per store per hour
const BULK_RATE_WINDOW_SECS     = 3600   // 1 hour
const MAX_PENDING_JOBS_PER_STORE = 200   // max queued+active jobs per store at any time

export async function POST(request: NextRequest) {
  const [user, body] = await Promise.all([
    getUser(),
    request.json(),
  ])
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const {
    storeId, filter, creativeType,
    variantScope = 'all', variantOption = null, imageScope = 'all',
    assetTypes = ['catalog'],
  } = body
  if (!storeId) return NextResponse.json({ error: 'storeId required' }, { status: 400 })

  // Server-side validation, independent of the UI's own checks — a client
  // that skips the disabled-button logic must not be able to send a
  // half-filled scope through.
  if (variantScope === 'specific') {
    const name = typeof variantOption?.name === 'string' ? variantOption.name.trim() : ''
    const value = typeof variantOption?.value === 'string' ? variantOption.value.trim() : ''
    if (!name || !value) {
      return NextResponse.json(
        { error: 'variantOption.name and .value are required when variantScope is "specific"' },
        { status: 400 }
      )
    }
  }
  if (imageScope !== 'all' && imageScope !== 'first') {
    return NextResponse.json({ error: 'imageScope must be "all" or "first"' }, { status: 400 })
  }

  const validatedAssetTypes: AssetType[] = Array.isArray(assetTypes)
    ? assetTypes.filter((t: unknown): t is AssetType => ALL_ASSET_TYPES.includes(t as AssetType))
    : []
  if (validatedAssetTypes.length === 0) {
    return NextResponse.json({ error: 'At least one valid assetType is required' }, { status: 400 })
  }

  // ── 1. Verify store ownership ─────────────────────────────────────────────
  const supabase = await createClient()
  const { data: store } = await supabase
    .from('stores').select('id').eq('id', storeId).eq('user_id', user.id).single()
  if (!store) return NextResponse.json({ error: 'Store not found' }, { status: 404 })

  // ── 2. Rate limit: max N bulk submissions per store per hour ──────────────
  // Prevents one team from re-submitting large batches repeatedly and
  // monopolising the generation queue.
  const rl = await rateLimit(`bulk:${storeId}`, BULK_RATE_LIMIT_PER_STORE, BULK_RATE_WINDOW_SECS)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: `Too many bulk generation requests for this store. Try again in ${rl.resetIn}s.` },
      { status: 429, headers: rateLimitHeaders(rl) }
    )
  }

  const admin = getAdminClient()

  // ── 3. Queue depth cap: reject if store already has too many pending jobs ─
  // This keeps the queue fair across teams: a single store cannot back up the
  // worker for hours for everyone else.
  const { count: pendingCount } = await admin
    .from('generation_jobs')
    .select('id', { count: 'exact', head: true })
    .eq('store_id', storeId)
    .in('status', ['pending', 'processing'])

  if ((pendingCount ?? 0) >= MAX_PENDING_JOBS_PER_STORE) {
    return NextResponse.json(
      {
        error: `Queue limit reached. This store already has ${pendingCount} jobs pending. ` +
               `Wait for them to finish before adding more.`,
        pendingCount,
      },
      { status: 429 }
    )
  }

  // ── 4. Collect product IDs ─────────────────────────────────────────────────
  let productIds: string[]
  try {
    productIds = await collectFilteredProductIds(storeId, filter, admin)
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'Failed to load products' }, { status: 500 })
  }

  if (productIds.length === 0) {
    return NextResponse.json({ message: 'No products matched', enqueued: 0 })
  }

  // ── 5. Fair priority: stores with fewer pending jobs get higher priority ──
  // BullMQ processes lower priority numbers first. A store with 0 pending jobs
  // gets priority=1, a store with 100 pending jobs gets priority=101.
  // This ensures that when multiple teams submit simultaneously, each team
  // gets a turn rather than the first team blocking everyone else.
  const basePriority = (pendingCount ?? 0) + 1

  // ── 6. Enqueue ─────────────────────────────────────────────────────────────
  const batchId = randomUUID()
  let enqueued: number
  try {
    enqueued = await enqueueGeneration(
      {
        storeId, productIds, creativeType: creativeType || 'default', batchId, basePriority,
        variantOption: variantScope === 'specific'
          ? { name: variantOption.name.trim(), value: variantOption.value.trim() }
          : null,
        imageScope,
        assetTypes: validatedAssetTypes,
      },
      admin
    )
  } catch (err: any) {
    // enqueueGeneration throws when the scope would exceed MAX_JOBS_PER_ENQUEUE —
    // surfaced as a 400 with its own actionable message, not a generic 500.
    return NextResponse.json({ error: err?.message || 'Failed to enqueue generation' }, { status: 400 })
  }

  if (enqueued === 0) {
    return NextResponse.json({ message: 'No variants/images matched this scope', enqueued: 0 })
  }

  const redisEnabled = isRedisEnabled()
  console.log(
    `[enqueue] batchId=${batchId} enqueued=${enqueued} priority=${basePriority} ` +
    `redisEnabled=${redisEnabled} storeId=${storeId} variantScope=${variantScope} ` +
    `imageScope=${imageScope} assetTypes=${validatedAssetTypes.join(',')}`
  )

  return NextResponse.json(
    { batchId, enqueued, redisEnabled, priority: basePriority },
    { headers: rateLimitHeaders(rl) }
  )
}