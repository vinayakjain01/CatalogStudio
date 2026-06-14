import IORedis from 'ioredis'

// ──────────────────────────────────────────────────────────────────────────
// Redis connection for BullMQ
//
// The queue is OPTIONAL by design: if `REDIS_URL` isn't set we skip Redis and
// the enqueue endpoint processes jobs inline (fine for dev / low volume). When
// Redis is present, jobs are queued and consumed by the worker process
// (`npm run worker`) with concurrency, retries and a dead-letter record.
//
// `maxRetriesPerRequest: null` is required by BullMQ for blocking commands.
// ──────────────────────────────────────────────────────────────────────────

const redisUrl = process.env.REDIS_URL

export const isQueueEnabled = Boolean(redisUrl)

let connection: IORedis | null = null

export function getRedisConnection(): IORedis | null {
  if (!redisUrl) return null
  if (!connection) {
    connection = new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    })
  }
  return connection
}
