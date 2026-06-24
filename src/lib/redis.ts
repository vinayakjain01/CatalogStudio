import IORedis from 'ioredis'

let connection: IORedis | null = null

export function isRedisEnabled() {
  return Boolean(process.env.REDIS_URL)
}

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

export async function closeRedisConnection() {
  if (!connection) return
  await connection.quit()
  connection = null
}