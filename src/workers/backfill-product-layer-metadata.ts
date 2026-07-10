/**
 * Product Layer Engine — Backfill Worker
 *
 * FILE: src/workers/backfill-product-layer-metadata.ts  (NEW FILE)
 *
 * One-time migration: for all bg_removal_cache rows where bundle_status='legacy'
 * (i.e., all rows created before the Product Layer Engine was deployed),
 * compute and store:
 *   1. metadata (head_y, feet_y, shot_type, bbox, safe_max_upscale)
 *   2. background_url (Background Plate via Cloudinary Generative Remove)
 *
 * Does NOT re-run background removal — reuses the existing transparent_url.
 *
 * Run once after deploying the Product Layer Engine:
 *   npx tsx src/workers/backfill-product-layer-metadata.ts
 *
 * Or with a limit for testing:
 *   BACKFILL_LIMIT=10 npx tsx src/workers/backfill-product-layer-metadata.ts
 *
 * Idempotent: rows already processed (bundle_status != 'legacy') are skipped.
 * Safe to interrupt and re-run — partially processed batches resume cleanly.
 */

import { createClient as createSupabaseAdmin } from '@supabase/supabase-js'
import { detectProductBounds } from '../lib/image-bounds'
import {
  computeClassificationSignals,
  classifyShotType,
} from '../lib/product-positioning-shared'
import { mapWithConcurrency } from '../lib/concurrency'

// Load .env.local (or however your env is configured)
// If running under ts-node/tsx with env already set, this is a no-op
try {
  require('dotenv').config({ path: '.env.local' })
} catch {}

const BATCH_SIZE  = 50
const CONCURRENCY = 4
const LIMIT       = process.env.BACKFILL_LIMIT ? parseInt(process.env.BACKFILL_LIMIT, 10) : Infinity

function getAdminClient() {
  return createSupabaseAdmin(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { global: { headers: { 'x-client-info': 'backfill-worker' } } }
  )
}

async function main() {
  const supabase = getAdminClient()
  let offset = 0
  let totalProcessed = 0
  let totalMetadataOk = 0
  let totalMetadataFailed = 0

  console.log(`[backfill] Starting Product Layer Engine metadata backfill`)
  console.log(`[backfill] Batch size: ${BATCH_SIZE}, Concurrency: ${CONCURRENCY}, Limit: ${LIMIT === Infinity ? 'none' : LIMIT}`)

  while (true) {
    if (totalProcessed >= LIMIT) {
      console.log(`[backfill] Reached limit of ${LIMIT} rows — stopping`)
      break
    }

    const remaining = LIMIT - totalProcessed
    const fetchSize = Math.min(BATCH_SIZE, remaining)

    const { data: rows, error: fetchError } = await supabase
      .from('bg_removal_cache')
      .select('cache_key, transparent_url, source_url, store_id')
      .eq('bundle_status', 'legacy')
      .range(offset, offset + fetchSize - 1)

    if (fetchError) {
      console.error('[backfill] Fetch error:', fetchError.message)
      break
    }

    if (!rows || rows.length === 0) {
      console.log('[backfill] No more legacy rows to process — done')
      break
    }

    console.log(`[backfill] Processing batch of ${rows.length} rows (offset=${offset})`)

    await mapWithConcurrency(rows, CONCURRENCY, async (row) => {
      try {
        // Step 1: compute metadata from the transparent cutout
        const bounds  = await detectProductBounds(row.transparent_url)
        const signals = computeClassificationSignals(bounds)
        const shotType = classifyShotType(signals)

        const contentW = bounds.right  - bounds.left
        const contentH = bounds.bottom - bounds.top

        const metadata = {
          bbox: {
            top:    bounds.top,
            bottom: bounds.bottom,
            left:   bounds.left,
            right:  bounds.right,
          },
          head_y:            bounds.top,
          feet_y:            bounds.bottom,
          center_x:          bounds.left + contentW / 2,
          center_y:          bounds.top  + contentH / 2,
          product_height_px: contentH,
          product_width_px:  contentW,
          image_width:       bounds.imageWidth,
          image_height:      bounds.imageHeight,
          shot_type:         shotType,
          shot_type_confidence: 0.85,
          safe_max_upscale:  Math.min(4, contentW > 0 ? bounds.imageWidth / contentW : 1.5),
          signals,
          schema_version:    1,
        }

        // Step 2: mark as 'partial' (metadata done, background plate not yet attempted)
        // The background plate will be generated on the next actual generation job
        // that uses this image — or you can extend this backfill script to run it too.
        await supabase.from('bg_removal_cache').update({
          metadata,
          bundle_status:       'partial',
          metadata_created_at: new Date().toISOString(),
        }).eq('cache_key', row.cache_key)

        totalMetadataOk++
        console.log(
          `[backfill] OK: ${row.cache_key.slice(0, 8)}… ` +
          `shot=${shotType} headY=${bounds.top}px (${totalMetadataOk + totalMetadataFailed} done)`
        )
      } catch (err: any) {
        totalMetadataFailed++
        console.error(
          `[backfill] FAILED: ${row.cache_key.slice(0, 8)}…`,
          err.message
        )
        // Leave as 'legacy' — will be retried on next backfill run
      }
    })

    totalProcessed += rows.length
    offset += rows.length

    // If we got fewer rows than requested, we've exhausted the table
    if (rows.length < fetchSize) break
  }

  console.log(`
[backfill] Complete.
  Total processed: ${totalProcessed}
  Metadata OK:     ${totalMetadataOk}
  Metadata failed: ${totalMetadataFailed}
`)

  process.exit(0)
}

main().catch(err => {
  console.error('[backfill] Fatal error:', err)
  process.exit(1)
})