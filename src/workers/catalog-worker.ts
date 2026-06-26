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

const generationConcurrency = parseInt(process.env.WORKER_GENERATION_CONCURRENCY || '4', 10)
const syncConcurrency = parseInt(process.env.WORKER_SYNC_CONCURRENCY || '1', 10)
// How often to poll DB for pending jobs (ms). Catches jobs Vercel couldn't push
// to Redis due to VPC network restrictions.
const DB_POLL_INTERVAL_MS = parseInt(process.env.DB_POLL_INTERVAL_MS || '3000', 10)

const admin = getAdminClient()

// ─────────────────────────────────────────────────────────────────────────────
// BullMQ workers (handles jobs pushed via Redis when Vercel CAN reach Redis)
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
// DB-poll loop — runs every DB_POLL_INTERVAL_MS regardless of Redis/BullMQ.
//
// WHY: Vercel is outside DigitalOcean's VPC, so it cannot push jobs into
// Valkey/Redis directly. Jobs land in generation_jobs with status='pending'
// but BullMQ never receives them. This loop claims and processes those rows
// directly from the DB, making the worker fully self-sufficient.
//
// When Vercel CAN reach Redis (public network enabled), BullMQ handles jobs
// faster. This loop acts as a safety net either way.
// ─────────────────────────────────────────────────────────────────────────────
let dbPollRunning = false
let dbPollActive = true

async function dbPollTick() {
  if (!dbPollActive || dbPollRunning) return
  dbPollRunning = true
  try {
    const result = await processBatch(generationConcurrency, generationConcurrency, admin)
    if (result.claimed > 0) {
      console.log(`[worker:db-poll] Processed DB batch: claimed=${result.claimed} completed=${result.completed} failed=${result.failed}`)
    }
  } catch (err: any) {
    console.error('[worker:db-poll] Error processing batch:', err.message)
  } finally {
    dbPollRunning = false
    if (dbPollActive) {
      setTimeout(dbPollTick, DB_POLL_INTERVAL_MS)
    }
  }
}

// Start the DB poll loop
console.log(`[worker:db-poll] Starting DB poll loop every ${DB_POLL_INTERVAL_MS}ms`)
dbPollTick()

// ─────────────────────────────────────────────────────────────────────────────
// Shutdown
// ─────────────────────────────────────────────────────────────────────────────
async function shutdown() {
  console.log('[worker] Shutting down…')
  dbPollActive = false
  await Promise.all(workers.map(worker => worker.close()))
  await closeCatalogQueues()
  await closeRedisConnection()
  console.log('[worker] Shutdown complete')
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

console.log('[worker] catalog workers started', {
  generationConcurrency,
  syncConcurrency,
  dbPollIntervalMs: DB_POLL_INTERVAL_MS,
  queues: QUEUE_NAMES,
})