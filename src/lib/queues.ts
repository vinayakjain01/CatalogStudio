/**
 * @module queues
 *
 * BullMQ queue management for the generation pipeline. All queues degrade to
 * a no-op (null queue / skipped enqueue) when Redis isn't configured, rather
 * than throwing.
 *
 * RESPONSIBILITIES:
 *   - QUEUE_NAMES — the two live BullMQ queue names (generation, productSync).
 *   - redisQueuesEnabled — whether Redis-backed queues are usable.
 *   - getCatalogQueue — lazily creates/returns a named BullMQ Queue instance.
 *   - enqueueCatalogJob — adds a single job to a named queue.
 *   - enqueueGenerationJobs — bulk-enqueues generation jobs with fair,
 *     per-batch priority.
 *   - closeCatalogQueues — closes and clears all cached Queue instances.
 *
 * DEPENDENCIES: getRedisConnection/isRedisEnabled (@/lib/redis).
 */
import { Queue, JobsOptions, ConnectionOptions } from 'bullmq'
import { getRedisConnection, isRedisEnabled } from '@/lib/redis'

// v2 runs two queues. `feed-generation` and `meta-refresh` were removed with the
// Meta section: both workers were empty placeholders that logged and returned
// `generated: false`, and the v2 feed is a live HTTP endpoint, not a queued job.
// `template-adaptation` went with that feature.
export const QUEUE_NAMES = {
  generation: 'creative-generation',
  productSync: 'product-sync',
} as const

export type CatalogQueueName = keyof typeof QUEUE_NAMES

const queues = new Map<CatalogQueueName, Queue>()

/** Whether Redis-backed queues are usable (mirrors isRedisEnabled). */
export function redisQueuesEnabled() {
  return isRedisEnabled()
}

/**
 * Get (creating and caching on first call) the BullMQ Queue for `name`.
 * @returns The Queue instance, or null when Redis is not configured.
 */
export function getCatalogQueue(name: CatalogQueueName) {
  const connection = getRedisConnection()
  if (!connection) return null

  const existing = queues.get(name)
  if (existing) return existing

  const queue = new Queue(QUEUE_NAMES[name], {
    connection: connection as unknown as ConnectionOptions,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { age: 60 * 60 * 24, count: 10_000 },
      removeOnFail: { age: 60 * 60 * 24 * 7, count: 10_000 },
    },
  })
  queues.set(name, queue)
  return queue
}

/** Add a single named job to a catalog queue. No-op (returns null) if Redis is disabled. */
export async function enqueueCatalogJob(
  queueName: CatalogQueueName,
  jobName: string,
  data: Record<string, unknown>,
  options: JobsOptions = {}
) {
  const queue = getCatalogQueue(queueName)
  if (!queue) return null
  return queue.add(jobName, data, options)
}

/**
 * Push job IDs to BullMQ.
 *
 * @param jobIds       DB job UUIDs to enqueue
 * @param basePriority BullMQ priority for the first job in this batch.
 *                     Lower number = higher priority (processed sooner).
 *                     Pass the store's current pending count so that stores
 *                     with fewer queued jobs are served first (fair round-robin).
 *                     Defaults to 100 (low priority) when not set.
 */
export async function enqueueGenerationJobs(
  jobIds: string[],
  basePriority = 100,
) {
  const queue = getCatalogQueue('generation')
  if (!queue || jobIds.length === 0) {
    console.warn(`[enqueueGenerationJobs] Skipped — queue=${queue ? 'ok' : 'null'} jobIds=${jobIds.length}`)
    return 0
  }

  console.log(`[enqueueGenerationJobs] Calling addBulk with ${jobIds.length} jobs priority=${basePriority} on queue "${QUEUE_NAMES.generation}"`)
  await queue.addBulk(jobIds.map((jobId, i) => ({
    name: 'generate-creative',
    data: { jobId },
    opts: {
      jobId:    `generation:${jobId}`,
      // Each successive job in the batch gets a slightly lower priority so that
      // other stores' jobs interleave between large batches from one store.
      priority: basePriority + i,
    },
  })))
  console.log(`[enqueueGenerationJobs] addBulk completed — ${jobIds.length} jobs queued`)
  return jobIds.length
}

/** Close every cached Queue instance and clear the internal cache. */
export async function closeCatalogQueues() {
  await Promise.all([...queues.values()].map(queue => queue.close()))
  queues.clear()
}