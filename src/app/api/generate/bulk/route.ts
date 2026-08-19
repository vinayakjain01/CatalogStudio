/**
 * POST /api/generate/bulk — enqueue bulk generation.
 *
 * The spec's name for the existing enqueue endpoint. It delegates rather than
 * reimplements: rate limiting, per-store job caps, rule matching and the BullMQ
 * push all live in one place, and a second copy would drift.
 *
 * Contract is identical to POST /api/generate/enqueue (see that file):
 * Auth:    Supabase session (getUser())
 * Rate:    max 5 bulk batches per store per hour (rateLimit(`bulk:${storeId}`, 5, 3600));
 *          429 with rateLimitHeaders() if exceeded
 * Body:    { storeId, filter?, creativeType?, variantScope?, variantOption?, imageScope? }
 * Returns: { batchId, enqueued, redisEnabled, priority } | { message, enqueued: 0 } | error responses
 */
export { POST } from '../enqueue/route'
export const dynamic = 'force-dynamic'
