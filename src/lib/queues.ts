import { Queue, JobsOptions, ConnectionOptions } from 'bullmq'
import { getRedisConnection, isRedisEnabled } from '@/lib/redis'

export const QUEUE_NAMES = {
  generation: 'creative-generation',
  productSync: 'product-sync',
  feedGeneration: 'feed-generation',
  metaRefresh: 'meta-refresh',
} as const

export type CatalogQueueName = keyof typeof QUEUE_NAMES

const queues = new Map<CatalogQueueName, Queue>()

export function redisQueuesEnabled() {
  return isRedisEnabled()
}

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

export async function enqueueGenerationJobs(jobIds: string[]) {
  const queue = getCatalogQueue('generation')
  if (!queue || jobIds.length === 0) {
    console.warn(`[enqueueGenerationJobs] Skipped — queue=${queue ? 'ok' : 'null'} jobIds=${jobIds.length}`)
    return 0
  }

  console.log(`[enqueueGenerationJobs] Calling addBulk with ${jobIds.length} jobs on queue "${QUEUE_NAMES.generation}"`)
  await queue.addBulk(jobIds.map(jobId => ({
    name: 'generate-creative',
    data: { jobId },
    opts: {
      jobId: `generation:${jobId}`,
    },
  })))
  console.log(`[enqueueGenerationJobs] addBulk completed — ${jobIds.length} jobs queued`)
  return jobIds.length
}

export async function closeCatalogQueues() {
  await Promise.all([...queues.values()].map(queue => queue.close()))
  queues.clear()
}