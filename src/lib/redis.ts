import IORedis from 'ioredis'

let connection: IORedis | null = null

export function isRedisEnabled() {
  return Boolean(process.env.REDIS_URL)
}

export function getRedisConnection() {
  if (!process.env.REDIS_URL) return null
  if (!connection) {
    connection = new IORedis(process.env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      tls: {
        rejectUnauthorized: false,
      },
    })
  }
  return connection
}

export async function closeRedisConnection() {
  if (!connection) return
  await connection.quit()
  connection = null
}
