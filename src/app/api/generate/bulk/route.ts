/**
 * POST /api/generate/bulk — enqueue bulk generation.
 *
 * The spec's name for the existing enqueue endpoint. It delegates rather than
 * reimplements: rate limiting, per-store job caps, rule matching and the BullMQ
 * push all live in one place, and a second copy would drift.
 */
export { POST } from '../enqueue/route'
export const dynamic = 'force-dynamic'
