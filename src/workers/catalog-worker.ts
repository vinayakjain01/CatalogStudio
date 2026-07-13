import { Worker, ConnectionOptions } from 'bullmq'
import { closeRedisConnection, getRedisConnection } from '@/lib/redis'
import { QUEUE_NAMES, closeCatalogQueues } from '@/lib/queues'
import { getAdminClient, processGenerationJob, processBatch } from '@/lib/generation-queue'
import { syncStoreProducts } from '@/lib/shopify-sync'
import { logPerf } from '@/lib/perf'

const connection = getRedisConnection()

if (!connection) {
  console.error('REDIS_URL is required to run catalog workers.')
  process.exit(1)
}

// Each generation job decodes several full-resolution images (original,
// transparent cutout, background plate) and holds multi-megapixel canvas
// buffers in memory — concurrency=4 reliably OOM-kills a 1GB worker host.
// Default to 1 and let bigger hosts opt into more via the env var.
const generationConcurrency = parseInt(process.env.WORKER_GENERATION_CONCURRENCY || '2', 10)
const syncConcurrency = parseInt(process.env.WORKER_SYNC_CONCURRENCY || '2', 10)
const DB_POLL_INTERVAL_MS = parseInt(process.env.DB_POLL_INTERVAL_MS || '3000', 10)

const admin = getAdminClient()

// ─────────────────────────────────────────────────────────────────────────────
// On startup: reset any rows stuck in 'processing' state back to 'pending'.
// These are jobs that were claimed by a previous worker process that crashed
// or was restarted before completing. Without this they stay stuck forever.
// ─────────────────────────────────────────────────────────────────────────────
async function resetStuckJobs() {
  // Permanently fail jobs that have exhausted their retries (attempts >= max_attempts)
  // so they never loop forever on OOM-crashing jobs.
  const { data: exhausted } = await admin
    .from('generation_jobs')
    .update({
      status:    'failed',
      locked_at: null,
      error:     'Max attempts reached — permanently failed (likely OOM or repeated crash)',
      updated_at: new Date().toISOString(),
    })
    .eq('status', 'processing')
    .gte('attempts', 3)   // default max_attempts = 3
    .select('id')

  if (exhausted && exhausted.length > 0) {
    console.warn(`[worker:startup] Permanently failed ${exhausted.length} exhausted jobs`)
  }

  // Reset remaining stuck jobs (still have retries left) back to pending
  const { data, error } = await admin
    .from('generation_jobs')
    .update({
      status:    'pending',
      locked_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('status', 'processing')
    .select('id')

  if (error) {
    console.error('[worker:startup] Failed to reset stuck jobs:', error.message)
  } else {
    const count = data?.length ?? 0
    if (count > 0) {
      console.log(`[worker:startup] Reset ${count} stuck processing jobs back to pending`)
    } else {
      console.log('[worker:startup] No stuck jobs found — clean start')
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// BullMQ workers (Redis path — used when Vercel can reach Valkey)
// ─────────────────────────────────────────────────────────────────────────────
const workers = [
  new Worker(
    QUEUE_NAMES.generation,
    async job => {
      const started = Date.now()
      const jobId = String(job.data.jobId || '')
      if (!jobId) throw new Error('jobId is required')
      console.log(`[worker:generation] BullMQ job received bullId=${job.id} dbJobId=${jobId}`)
      const result = await processGenerationJob(jobId, admin)
      const elapsed = Date.now() - started
      console.log(`[worker:generation] BullMQ job done bullId=${job.id} dbJobId=${jobId} completed=${result.completed} failed=${result.failed} ms=${elapsed}`)
      logPerf('worker.generation.job', elapsed, {
        bullJobId: String(job.id),
        dbJobId: jobId,
        processed: result.processed,
        completed: result.completed,
        failed: result.failed,
      })
      return result
    },
    { connection: connection as unknown as ConnectionOptions, concurrency: generationConcurrency }
  ),

  new Worker(
    QUEUE_NAMES.productSync,
    async job => {
      const started = Date.now()
      const storeId = String(job.data.storeId || '')
      if (!storeId) throw new Error('storeId is required')
      const synced = await syncStoreProducts({
        storeId,
        syncType: 'cron',
        incremental: Boolean(job.data.incremental ?? true),
        autoEnqueueChanged: Boolean(job.data.autoEnqueueChanged ?? true),
        supabase: admin,
      })
      logPerf('worker.product_sync.job', Date.now() - started, { storeId, synced })
      return { synced }
    },
    { connection: connection as unknown as ConnectionOptions, concurrency: syncConcurrency }
  ),

  new Worker(
    QUEUE_NAMES.feedGeneration,
    async job => {
      const started = Date.now()
      const storeId = String(job.data.storeId || '')
      if (!storeId) throw new Error('storeId is required')
      logPerf('worker.feed_generation.job', Date.now() - started, { storeId, status: 'queued-placeholder' })
      return { storeId, generated: false }
    },
    { connection: connection as unknown as ConnectionOptions, concurrency: 1 }
  ),

  new Worker(
    QUEUE_NAMES.metaRefresh,
    async job => {
      const started = Date.now()
      const storeId = String(job.data.storeId || '')
      if (!storeId) throw new Error('storeId is required')
      logPerf('worker.meta_refresh.job', Date.now() - started, { storeId, status: 'queued-placeholder' })
      return { storeId, refreshed: false }
    },
    { connection: connection as unknown as ConnectionOptions, concurrency: 1 }
  ),
]

for (const worker of workers) {
  worker.on('completed', job => {
    console.log(`[worker] ${worker.name} completed BullMQ job ${job.id}`)
  })
  worker.on('failed', (job, err) => {
    console.error(`[worker] ${worker.name} failed BullMQ job ${job?.id}:`, err.message)
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// DB-poll loop — polls generation_jobs every 3s for pending rows.
// This is the primary execution path because Vercel (AWS) cannot reach
// DigitalOcean Valkey over VPC. Jobs are written to Supabase by Vercel,
// and this loop claims and processes them directly — no Redis push needed.
// ─────────────────────────────────────────────────────────────────────────────
let dbPollRunning = false
let dbPollActive = true

async function dbPollTick() {
  if (!dbPollActive || dbPollRunning) return
  dbPollRunning = true
  try {
    const result = await processBatch(generationConcurrency, generationConcurrency, admin)
    if (result.claimed > 0) {
      console.log(`[worker:db-poll] claimed=${result.claimed} completed=${result.completed} failed=${result.failed}`)
    }
  } catch (err: any) {
    console.error('[worker:db-poll] Error:', err.message)
  } finally {
    dbPollRunning = false
    if (dbPollActive) setTimeout(dbPollTick, DB_POLL_INTERVAL_MS)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shutdown
// ─────────────────────────────────────────────────────────────────────────────
async function shutdown() {
  console.log('[worker] Shutting down…')
  dbPollActive = false
  await Promise.all(workers.map(w => w.close()))
  await closeCatalogQueues()
  await closeRedisConnection()
  console.log('[worker] Shutdown complete')
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// ─────────────────────────────────────────────────────────────────────────────
// Boot sequence
// ─────────────────────────────────────────────────────────────────────────────
console.log('[worker] catalog workers starting…', {
  generationConcurrency,
  syncConcurrency,
  dbPollIntervalMs: DB_POLL_INTERVAL_MS,
  queues: QUEUE_NAMES,
})

resetStuckJobs().then(() => {
  console.log(`[worker:db-poll] Starting DB poll loop every ${DB_POLL_INTERVAL_MS}ms`)
  dbPollTick()
})