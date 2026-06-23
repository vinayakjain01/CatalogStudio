import { Worker, ConnectionOptions } from 'bullmq'
import { closeRedisConnection, getRedisConnection } from '@/lib/redis'
import { QUEUE_NAMES, closeCatalogQueues } from '@/lib/queues'
import { getAdminClient, processGenerationJob } from '@/lib/generation-queue'
import { syncStoreProducts } from '@/lib/shopify-sync'
import { logPerf } from '@/lib/perf'

const connection = getRedisConnection()

if (!connection) {
  console.error('REDIS_URL is required to run catalog workers.')
  process.exit(1)
}

const generationConcurrency = parseInt(process.env.WORKER_GENERATION_CONCURRENCY || '4', 10)
const syncConcurrency = parseInt(process.env.WORKER_SYNC_CONCURRENCY || '1', 10)

const admin = getAdminClient()

const workers = [
  new Worker(
    QUEUE_NAMES.generation,
    async job => {
      const started = Date.now()
      const jobId = String(job.data.jobId || '')
      if (!jobId) throw new Error('jobId is required')
      const result = await processGenerationJob(jobId, admin)
      logPerf('worker.generation.job', Date.now() - started, {
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
      logPerf('worker.feed_generation.job', Date.now() - started, {
        storeId,
        status: 'queued-placeholder',
      })
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
      logPerf('worker.meta_refresh.job', Date.now() - started, {
        storeId,
        status: 'queued-placeholder',
      })
      return { storeId, refreshed: false }
    },
    { connection: connection as unknown as ConnectionOptions, concurrency: 1 }
  ),
]

for (const worker of workers) {
  worker.on('completed', job => {
    console.log(`[worker] ${worker.name} completed job ${job.id}`)
  })
  worker.on('failed', (job, err) => {
    console.error(`[worker] ${worker.name} failed job ${job?.id}:`, err)
  })
}

async function shutdown() {
  console.log('[worker] shutting down')
  await Promise.all(workers.map(worker => worker.close()))
  await closeCatalogQueues()
  await closeRedisConnection()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

console.log('[worker] catalog workers started', {
  generationConcurrency,
  syncConcurrency,
  queues: QUEUE_NAMES,
})
