import { createClient as createSupabaseAdmin, SupabaseClient } from '@supabase/supabase-js'
// ws is required for Supabase Realtime on Node.js < 22 (no native WebSocket global)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ws = require('ws') as any
import {
  getActiveTemplateRules,
  resolveTemplateFromRules,
  TemplateRule,
} from '@/lib/template-resolver'
import { compositeImage } from '@/lib/compositor'
import { uploadBuffer } from '@/lib/cloudinary'
// CHANGED: replaced getTransparentProductImage + getReconstructedBackground with getProductLayerBundle
import { getProductLayerBundle } from '@/lib/product-layer-engine'
import { mapWithConcurrency } from '@/lib/concurrency'
import { logPerf, measureAsync } from '@/lib/perf'
import { enqueueGenerationJobs, redisQueuesEnabled } from '@/lib/queues'
import type { CompositorBundle } from '@/types/product-layer'

export function getAdminClient(): SupabaseClient {
  return createSupabaseAdmin(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      realtime: {
        // Node.js 20 has no native WebSocket global — must pass ws explicitly.
        transport: ws,
      },
      global: {
        headers: { 'x-client-info': 'catalog-worker' },
      },
    }
  )
}

export interface EnqueueArgs {
  storeId: string
  productIds: string[]      // internal product UUIDs
  creativeType?: string     // default 'default'
  batchId?: string
  /**
   * BullMQ job priority for this batch. Lower = processed sooner.
   * Set to the store's current pending-job count so stores with fewer
   * queued jobs are served first (fair round-robin across teams).
   * Defaults to 100 when not provided (low priority / FIFO).
   */
  basePriority?: number
}

/**
 * Enqueue one generation job per product. Idempotent-ish: callers that re-enqueue
 * the same product create a new job row; the worker upserts the resulting creative
 * by (product, template, creative_type), so duplicates collapse at write time.
 */
export async function enqueueGeneration(
  { storeId, productIds, creativeType = 'default', batchId, basePriority = 100 }: EnqueueArgs,
  supabase: SupabaseClient = getAdminClient()
): Promise<number> {
  if (productIds.length === 0) return 0

  console.log(`[enqueueGeneration] START storeId=${storeId} products=${productIds.length} batchId=${batchId ?? 'none'}`)

  const rows = productIds.map(pid => ({
    store_id: storeId,
    product_id: pid,
    creative_type: creativeType,
    status: 'pending',
    batch_id: batchId ?? null,
  }))
  const { data, error } = await measureAsync(
    'queue.generation.db_enqueue',
    () => supabase
    .from('generation_jobs')
    .insert(rows)
    .select('id'),
    { rows: rows.length, storeId }
  )
  if (error) {
    console.error(`[enqueueGeneration] DB insert failed:`, error.message)
    throw new Error(error.message)
  }

  const insertedIds = (data || []).map((row: any) => row.id)
  console.log(`[enqueueGeneration] DB rows inserted: ${insertedIds.length} jobIds=[${insertedIds.slice(0, 3).join(',')}${insertedIds.length > 3 ? '…' : ''}]`)

  if (redisQueuesEnabled()) {
    console.log(`[enqueueGeneration] Redis enabled — pushing ${insertedIds.length} jobs to BullMQ queue`)
    try {
      const pushed = await measureAsync(
        'queue.generation.redis_enqueue',
        () => enqueueGenerationJobs(insertedIds, basePriority),
        { rows: insertedIds.length, storeId }
      )
      console.log(`[enqueueGeneration] Redis addBulk OK — pushed=${pushed}`)
    } catch (err) {
      console.error('[enqueueGeneration] Redis enqueue failed; DB queue remains available:', err)
    }
  } else {
    console.warn('[enqueueGeneration] REDIS_URL not set — jobs are in DB only, BullMQ worker will NOT receive them')
  }

  return insertedIds.length > 0 ? insertedIds.length : rows.length
}

/**
 * Claim and process up to `batchSize` pending jobs directly from the DB.
 * Does NOT require any Postgres RPC function — uses a select+update pattern.
 * Safe for concurrent callers: each job is only claimed once via status check.
 */
export async function processBatch(
  batchSize = 10,
  concurrency = 4,
  supabase: SupabaseClient = getAdminClient()
): Promise<{ claimed: number; completed: number; failed: number }> {
  const { data: pendingJobs, error: selectError } = await supabase
    .from('generation_jobs')
    .select('id')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(batchSize)

  if (selectError) throw new Error(selectError.message)
  if (!pendingJobs || pendingJobs.length === 0) return { claimed: 0, completed: 0, failed: 0 }

  const ids = pendingJobs.map((j: any) => j.id)

  // Step 1: Claim the jobs (mark processing)
  const { data: claimed, error: claimError } = await supabase
    .from('generation_jobs')
    .update({
      status:     'processing',
      locked_at:  new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .in('id', ids)
    .eq('status', 'pending')
    .select('*')

  if (claimError) throw new Error(claimError.message)
  if (!claimed || claimed.length === 0) return { claimed: 0, completed: 0, failed: 0 }

  // Step 2: Increment attempts immediately after claiming.
  // This ensures that OOM crashes (where failJob never runs) still count as
  // an attempt — preventing infinite retry loops on jobs that always crash.
  const claimedIds = claimed.map((j: any) => j.id)
  await supabase.rpc('increment_job_attempts', { job_ids: claimedIds }).throwOnError()

  console.log(`[processBatch] Claimed ${claimed.length} jobs from DB`)

  let completed = 0
  let failed = 0
  const context = createJobContext()

  await mapWithConcurrency(claimed, concurrency, async job => {
    // Write a "started" timestamp so errors during crash can be diagnosed from logs
    await supabase.from('generation_jobs')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', job.id)

    try {
      await runJob(job, supabase, context)
      completed++
    } catch (err: any) {
      failed++
      const errMsg = err?.message ?? String(err)
      console.error(`[processBatch] Job failed jobId=${job.id} productId=${job.product_id}: ${errMsg}`)
      await failJob(job, errMsg, supabase)
    }
  })

  return { claimed: claimed.length, completed, failed }
}

export async function processGenerationJob(
  jobId: string,
  supabase: SupabaseClient = getAdminClient()
): Promise<{ processed: boolean; completed: boolean; failed: boolean }> {
  console.log(`[processGenerationJob] Claiming job jobId=${jobId}`)

  const { data: job, error } = await measureAsync(
    'queue.generation.claim_one',
    () => supabase
      .from('generation_jobs')
      .update({
        status: 'processing',
        locked_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId)
      .eq('status', 'pending')
      .select('*')
      .maybeSingle(),
    { jobId }
  )

  if (error) {
    console.error(`[processGenerationJob] Claim error jobId=${jobId}:`, error.message)
    throw new Error(error.message)
  }
  if (!job) {
    const { data: check } = await supabase
      .from('generation_jobs').select('status').eq('id', jobId).maybeSingle()
    console.warn(`[processGenerationJob] Job not claimable jobId=${jobId} current_status=${check?.status ?? 'not_found'} — skipping`)
    return { processed: false, completed: false, failed: false }
  }

  console.log(`[processGenerationJob] Processing jobId=${jobId} productId=${job.product_id} storeId=${job.store_id}`)

  try {
    await runJob(job, supabase, createJobContext())
    console.log(`[processGenerationJob] Completed jobId=${jobId} productId=${job.product_id}`)
    return { processed: true, completed: true, failed: false }
  } catch (err: any) {
    console.error(`[processGenerationJob] Failed jobId=${jobId} productId=${job.product_id}:`, err.message)
    await failJob(job, err.message, supabase)
    return { processed: true, completed: false, failed: true }
  }
}

type JobContext = {
  rulesByStore: Map<string, Promise<TemplateRule[]>>
  templatesById: Map<string, Promise<any>>
}

function createJobContext(): JobContext {
  return {
    rulesByStore: new Map(),
    templatesById: new Map(),
  }
}

function getRulesForStore(storeId: string, context: JobContext) {
  const cached = context.rulesByStore.get(storeId)
  if (cached) return cached
  const promise = measureAsync(
    'supabase.template_rules.load',
    () => getActiveTemplateRules(storeId),
    { storeId }
  )
  context.rulesByStore.set(storeId, promise)
  return promise
}

function getTemplateCanvas(templateId: string, supabase: SupabaseClient, context: JobContext) {
  const cached = context.templatesById.get(templateId)
  if (cached) return cached
  const promise = measureAsync(
    'supabase.templates.load',
    async () => {
      const { data: template, error } = await supabase
        .from('templates')
        .select('canvas_data')
        .eq('id', templateId)
        .single()
      if (error) throw new Error(error.message)
      if (!template) throw new Error('Template not found')
      return template.canvas_data
    },
    { templateId }
  )
  context.templatesById.set(templateId, promise)
  return promise
}

async function runJob(job: any, supabase: SupabaseClient, context: JobContext) {
  const started = Date.now()

  // Load product and template rules in PARALLEL — previously sequential (~130ms saved).
  // Rules are cached in `context.templateRules` after the first call (see getRulesForStore),
  // so for subsequent jobs in the same batch the rules lookup is instant.
  const [productResult, rules] = await Promise.all([
    measureAsync(
      'supabase.products.load_for_generation',
      () => supabase
        .from('products')
        .select(`id, title, vendor, product_type, tags, price, compare_at_price, import_id, shot_type_override,
          product_images(src, is_primary)`)
        .eq('id', job.product_id)
        .single(),
      { productId: job.product_id }
    ),
    getRulesForStore(job.store_id, context),
  ])

  const { data: product, error: productError } = productResult
  if (productError) throw new Error(productError.message)
  if (!product) throw new Error('Product not found')

  const templateId = job.template_id || resolveTemplateFromRules(
    {
      id: product.id,
      tags: product.tags || [],
      vendor: product.vendor,
      product_type: product.product_type,
      price: product.price,
      compare_at_price: product.compare_at_price,
    },
    rules
  )
  if (!templateId) {
    await supabase.from('generation_jobs')
      .update({ status: 'completed', error: 'no matching rule', updated_at: new Date().toISOString() })
      .eq('id', job.id)
    return
  }
  const canvasData = await getTemplateCanvas(templateId, supabase, context)

  const images = (product as any).product_images || []
  const primary = images.find((i: any) => i.is_primary) || images[0]
  const imageUrl: string | null = primary?.src || null

  const templateMode: 'standard' | 'ai_product' | 'product_zoom' = (canvasData as any).templateMode || 'standard'

  // ── CHANGED: Product Layer Engine replaces the two separate AI calls ─────────
  //
  // Previously generation-queue.ts called:
  //   1. getTransparentProductImage()   → transparent cutout
  //   2. getReconstructedBackground()   → background plate (for 'original' mode only)
  //
  // Now it calls getProductLayerBundle() ONCE, which:
  //   - Returns all 3 assets (transparent + backgroundUrl + metadata) from cache if available
  //   - Runs AI only on first encounter of this source URL
  //   - Stores everything in bg_removal_cache (extended by migration SQL)
  //   - Is non-fatal: partial bundles (no backgroundUrl) still complete the job
  //
  // The compositor receives bundle.backgroundUrl via options.productLayerBundle,
  // which it uses as the fixed Background Plate in serverRenderBackground().
  // The compositor receives bundle.metadata via options.productLayerBundle,
  // which calculateSmartFitPlacement() uses for instant Head Space math.

  let productLayerBundle: CompositorBundle | null = null

  if (templateMode === 'ai_product' && imageUrl) {
    try {
      const bundle = await measureAsync(
        'product_layer_engine.get_bundle',
        () => getProductLayerBundle(imageUrl, job.store_id, supabase),
        { productId: product.id, templateId }
      )

      productLayerBundle = {
        transparentUrl: bundle.transparentUrl,
        backgroundUrl:  bundle.backgroundUrl,
        metadata:       bundle.metadata,
      }

      // Keep backward-compatible job tracking fields (existing dashboard reads these)
      await supabase.from('generation_jobs')
        .update({
          bg_removal_status: bundle.fromCache ? 'cached' : 'done',
          transparent_url:   bundle.transparentUrl,
          updated_at:        new Date().toISOString(),
        })
        .eq('id', job.id)

      console.log(
        `[runJob] Product Layer Bundle ${bundle.fromCache ? 'cached' : 'fresh'} ` +
        `status=${bundle.bundleStatus} shot=${bundle.metadata.shot_type} ` +
        `bgPlate=${bundle.backgroundUrl ? 'yes' : 'no'} jobId=${job.id}`
      )
    } catch (bundleErr: any) {
      // Non-fatal: fall back to standard mode (no transparent, no plate)
      console.error(`[runJob] Product Layer Bundle failed, falling back to standard:`, bundleErr.message)
      await supabase.from('generation_jobs')
        .update({ bg_removal_status: 'failed', updated_at: new Date().toISOString() })
        .eq('id', job.id)
    }
  } else if (templateMode === 'standard' || templateMode === 'product_zoom') {
    // product_zoom: no cutout is ever needed — the original photo is drawn
    // as a single unit (see compositor.ts's product_zoom branch).
    await supabase.from('generation_jobs')
      .update({ bg_removal_status: 'skipped', updated_at: new Date().toISOString() })
      .eq('id', job.id)
  }
  // ── End Product Layer Engine block ───────────────────────────────────────────

  const productLayerSettings = (canvasData as any).productLayerSettings || undefined

  const buffer = await compositeImage(canvasData as any, {
    title:           product.title,
    price:           product.price,
    compare_at_price: product.compare_at_price,
    vendor:          product.vendor,
    product_type:    product.product_type,
    imageUrl,
    // transparentImageUrl: sourced from bundle when present
    transparentImageUrl: productLayerBundle?.transparentUrl ?? null,
    shotTypeOverride:    (product as any).shot_type_override ?? null,
    // reconstructedBackgroundUrl: no longer needed — bundle.backgroundUrl handles this
    // via options.productLayerBundle in the compositor. Pass null to avoid legacy path.
    reconstructedBackgroundUrl: null,
  }, {
    templateMode,
    productLayerSettings,
    storeId:            job.store_id,
    supabase,
    // NEW: pass the full bundle so compositor can use Background Plate + Smart Fit 2.0
    productLayerBundle: productLayerBundle ?? undefined,
  })

  // JPEG output sanity check — FF D8 = JPEG Start Of Image marker.
  // (Previously checked for PNG magic bytes 0x89 0x50, which caused every job
  // to fail after the compositor was switched to JPEG output.)
  if (buffer.length < 1000 || buffer[0] !== 0xFF || buffer[1] !== 0xD8) {
    throw new Error('Invalid image buffer from compositor')
  }

  const publicId = `product_${product.id}_${templateId}_${job.creative_type}`
  const { deliveredUrl, publicId: cloudPublicId } = await measureAsync(
    'cloudinary.upload',
    () => uploadBuffer(buffer, publicId),
    { productId: product.id, templateId, bytes: buffer.length }
  )

  const { error: upsertError } = await measureAsync(
    'supabase.generated_images.upsert',
    () => supabase.from('generated_images').upsert(
      {
        product_id:           product.id,
        template_id:          templateId,
        creative_type:        job.creative_type,
        cloudinary_public_id: cloudPublicId,
        generated_url:        deliveredUrl,
        status:               'completed',
        updated_at:           new Date().toISOString(),
      },
      { onConflict: 'product_id,template_id,creative_type' }
    ),
    { productId: product.id, templateId }
  )
  if (upsertError) throw new Error(upsertError.message)

  await supabase.from('generation_jobs')
    .update({ status: 'completed', updated_at: new Date().toISOString() })
    .eq('id', job.id)

  logPerf('queue.generation.job_total', Date.now() - started, {
    jobId: job.id,
    productId: product.id,
    templateId,
  })
}

async function failJob(job: any, message: string, supabase: SupabaseClient) {
  // Re-read current attempts from DB (may have been incremented at claim time)
  const { data: current } = await supabase
    .from('generation_jobs')
    .select('attempts, max_attempts')
    .eq('id', job.id)
    .maybeSingle()

  const attempts   = current?.attempts    ?? job.attempts
  const maxAttempts = current?.max_attempts ?? job.max_attempts
  const willRetry  = attempts < maxAttempts

  await supabase.from('generation_jobs')
    .update({
      status:    willRetry ? 'pending' : 'failed',
      locked_at: null,
      error:     message?.slice(0, 500),
      updated_at: new Date().toISOString(),
    })
    .eq('id', job.id)

  if (!willRetry) {
    console.warn(`[generation-queue] Job permanently failed after ${attempts}/${maxAttempts} attempts: ${job.id}`)
  }
}