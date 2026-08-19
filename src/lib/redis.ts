/**
 * @module redis
 *
 * Lazily-created, process-wide Redis (Valkey) connection used by the job
 * queues and rate limiter. Gracefully degrades when REDIS_URL is unset —
 * callers must treat a null connection as "Redis is not configured" rather
 * than an error.
 *
 * RESPONSIBILITIES:
 *   - isRedisEnabled — whether REDIS_URL is configured.
 *   - getRedisConnection — returns the shared ioredis connection, or null.
 *   - closeRedisConnection — closes and clears the shared connection.
 */
import IORedis from 'ioredis'

let connection: IORedis | null = null

/** Whether REDIS_URL is configured in the environment. */
export function isRedisEnabled() {
  return Boolean(process.env.REDIS_URL)
}

/**
 * Get the shared ioredis connection, creating it on first call.
 * Returns null when REDIS_URL is unset — callers must handle this as
 * "Redis disabled" rather than an error.
 */
export function getRedisConnection() {
  if (!process.env.REDIS_URL) return null
  if (!connection) {
    // DigitalOcean Managed Redis uses rediss:// (TLS). A plain redis:// URL
    // (e.g. local dev) must NOT set tls or ioredis fails to connect.
    const useTls = process.env.REDIS_URL.startsWith('rediss://')
    connection = new IORedis(process.env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      ...(useTls ? { tls: {} } : {}),
    })
  }
  return connection
}

/** Close and clear the shared Redis connection, if one exists. */
export async function closeRedisConnection() {
  if (!connection) return
  await connection.quit()
  connection = null
}