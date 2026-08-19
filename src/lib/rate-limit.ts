/**
 * @module rate-limit
 *
 * Redis-backed sliding-window rate limiter for API routes, with fail-open
 * behavior when Redis is unavailable.
 *
 * RESPONSIBILITIES:
 *   - rateLimit — checks/increments a windowed counter for a given key.
 *   - rateLimitHeaders — builds standard X-RateLimit-* response headers.
 *
 * DEPENDENCIES: getRedisConnection (@/lib/redis) — returns null when
 * REDIS_URL is unset, which this module treats as "allow everything".
 */
    import { getRedisConnection } from './redis'

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  resetIn: number   // seconds until the window resets
  limit: number
}

/**
 * Sliding-window rate limiter backed by Redis (Valkey).
 *
 * If Redis is unavailable the call is always allowed — fail open rather than
 * blocking legitimate work. The caller should log a warning in that case.
 *
 * @param key        Unique key for this bucket, e.g. `bulk:${storeId}`
 * @param limit      Maximum number of requests allowed in the window
 * @param windowSecs Window size in seconds
 *
 * @example
 *   // Max 3 bulk-enqueues per store per hour
 *   const rl = await rateLimit(`bulk:${storeId}`, 3, 3600)
 *   if (!rl.allowed) return res.status(429).json({ error: 'Rate limit hit' })
 */
export async function rateLimit(
  key: string,
  limit: number,
  windowSecs: number
): Promise<RateLimitResult> {
  const redis = getRedisConnection()

  if (!redis) {
    // Redis not configured — fail open (allow), log once
    console.warn(`[rate-limit] Redis unavailable — skipping check for key="${key}"`)
    return { allowed: true, remaining: limit, resetIn: windowSecs, limit }
  }

  try {
    const now    = Math.floor(Date.now() / 1000)
    const window = Math.floor(now / windowSecs)
    const rKey   = `rl:${key}:${window}`

    // Atomic increment + expiry in one pipeline
    const [[, count]] = (await redis
      .multi()
      .incr(rKey)
      .expire(rKey, windowSecs * 2)   // 2× so the key doesn't vanish mid-window
      .exec()) as [[null, number], [null, number]]

    const remaining = Math.max(0, limit - count)
    const resetIn   = (window + 1) * windowSecs - now

    return { allowed: count <= limit, remaining, resetIn, limit }
  } catch (err) {
    console.error(`[rate-limit] Redis error for key="${key}":`, err)
    // Fail open — don't block users because of an infra hiccup
    return { allowed: true, remaining: limit, resetIn: windowSecs, limit }
  }
}

/** Attach standard rate-limit headers to a response. */
export function rateLimitHeaders(rl: RateLimitResult): Record<string, string> {
  return {
    'X-RateLimit-Limit':     String(rl.limit),
    'X-RateLimit-Remaining': String(rl.remaining),
    'X-RateLimit-Reset':     String(Math.floor(Date.now() / 1000) + rl.resetIn),
    ...(rl.allowed ? {} : { 'Retry-After': String(rl.resetIn) }),
  }
}