import { Queue, type ConnectionOptions } from 'bullmq'
import { getRedisConnection, isQueueEnabled } from './connection'

export const GENERATION_QUEUE = 'generation'

export interface GenerationJobData {
  /** generation_jobs.id — the DB row tracking this job's lifecycle. */
  jobId: string
  productId: string
  storeId: string
  /** Optional explicit template; when omitted the rules engine resolves one. */
  templateId?: string | null
}

let generationQueue: Queue | null = null

/**
 * Returns the generation queue, or `null` when Redis isn't configured (callers
 * then fall back to inline processing). Failed jobs are retained
 * (`removeOnFail: false`) so they act as a queryable dead-letter record.
 */
export function getGenerationQueue(): Queue | null {
  if (!isQueueEnabled) return null
  const connection = getRedisConnection()
  if (!connection) return null

  if (!generationQueue) {
    generationQueue = new Queue(GENERATION_QUEUE, {
      connection: connection as ConnectionOptions,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 1000,
        removeOnFail: false,
      },
    })
  }
  return generationQueue
}
