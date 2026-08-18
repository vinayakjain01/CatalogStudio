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
import { recordCreative } from '@/lib/creatives'
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
  /**
   * Restrict to variants where one named option matches a value
   * (e.g. Size: M). Omitted/null generates every variant, unchanged.
   */
  variantOption?: { name: string; value: string } | null
  /**
   * Which of a variant's images to generate from.
   *
   *   'first' (default) — one job per variant, its first/primary image. This
   *      is the ORIGINAL behaviour (one job per variant, image chosen at
   *      render time) and is the default so every caller that doesn't pass
   *      this — the sync's auto-enqueue-on-change, in particular — keeps
   *      producing exactly the job count it always has.
   *   'all' — one job per variant PER IMAGE. Opt-in, from the Generate
   *      Creatives page's "All poses" scope.
   */
  imageScope?: 'all' | 'first'
}

/**
 * Above this, a single enqueue call is rejected rather than silently accepted.
 *
 * Fanning out per image multiplies job count by however many photos a variant
 * has: a catalog with ~9.5k variants and ~5 images/product can reach tens of
 * thousands of rows from one click of "All variants + All poses + All
 * products". That is real, measured behaviour on this codebase's own test
 * store, not a hypothetical — hence a hard ceiling rather than just a comment.
 */
export const MAX_JOBS_PER_ENQUEUE = 5000

/**
 * Enqueue one generation job per (variant, image) — or per product, for a
 * product with no synced variants. Idempotent-ish: callers that re-enqueue the
 * same variant+image create a new job row; the worker upserts the resulting
 * creative by (variant, image, template) [or (product, template,
 * creative_type) for the legacy product-level path], so duplicates collapse
 * at write time rather than accumulating.
 */
export async function enqueueGeneration(
  {
    storeId, productIds, creativeType = 'default', batchId, basePriority = 100,
    variantOption = null, imageScope = 'first',
  }: EnqueueArgs,
  supabase: SupabaseClient = getAdminClient()
): Promise<number> {
  if (productIds.length === 0) return 0

  console.log(
    `[enqueueGeneration] START storeId=${storeId} products=${productIds.length} ` +
    `batchId=${batchId ?? 'none'} variantOption=${variantOption ? `${variantOption.name}:${variantOption.value}` : 'none'} imageScope=${imageScope}`
  )

  // v2 fans out per VARIANT: each variant carries its own price, stock and
  // sold-out state, all of which appear in the creative's dynamic fields and
  // conditional badges. One job per product would render every colour/size with
  // variant[0]'s numbers.
  //
  // Products with no variant rows still get a single product-level job, so a
  // catalog that has not been re-synced since the variant migration keeps working.
  const { data: variantRows, error: variantError } = await supabase
    .from('product_variants')
    .select('id, product_id, shopify_variant_id, option1, option2, option3')
    .in('product_id', productIds)
    .order('position', { ascending: true })

  if (variantError) {
    console.warn('[enqueueGeneration] variant lookup failed, falling back to product-level jobs:', variantError.message)
  }

  let variants = variantRows ?? []

  // ── Scope: specific option ────────────────────────────────────────────────
  if (variantOption && variantOption.name && variantOption.value) {
    variants = await filterVariantsByOption(variants, productIds, variantOption, supabase)
  }

  const variantsByProduct = new Map<string, typeof variants>()
  for (const row of variants) {
    const list = variantsByProduct.get((row as any).product_id) ?? []
    list.push(row)
    variantsByProduct.set((row as any).product_id, list)
  }

  // ── Scope: images ─────────────────────────────────────────────────────────
  // Only fetched when at least one product has a variant to attach images to —
  // a store with variantOption filtering everything out shouldn't still pay
  // for this query.
  const imagesByProduct = variantsByProduct.size > 0
    ? await loadImagesByProduct(Array.from(variantsByProduct.keys()), supabase)
    : new Map<string, ImageRow[]>()

  const rows: Array<{
    store_id: string
    product_id: string
    variant_id?: string
    image_id?: string
    creative_type: string
    status: string
    batch_id: string | null
  }> = []

  for (const pid of productIds) {
    const productVariants = variantsByProduct.get(pid)

    // Legacy path: no synced variants for this product. Unaffected by
    // variantOption (nothing to filter) or imageScope (rare/pre-v2 data;
    // kept as the original single job, image chosen at render time) —
    // preserving exact prior behaviour for a path real stores no longer hit.
    if (!productVariants || productVariants.length === 0) {
      // variantOption filtering removes ALL variants of every product that
      // doesn't have variant rows to begin with — those never reach this
      // branch. But a product WITH variants that all got filtered OUT by
      // variantOption must not fall back to a variant-less product-level job;
      // that would silently ignore the filter. Only products absent from
      // variantsByProduct (never had rows) take this path.
      if (variantOption) continue
      rows.push({
        store_id: storeId,
        product_id: pid,
        creative_type: creativeType,
        status: 'pending',
        batch_id: batchId ?? null,
      })
      continue
    }

    const productImages = imagesByProduct.get(pid) ?? []

    for (const variant of productVariants) {
      const images = imagesForVariant(productImages, (variant as any).shopify_variant_id, imageScope)
      for (const img of images) {
        rows.push({
          store_id: storeId,
          product_id: pid,
          variant_id: (variant as any).id,
          image_id: img.id,
          creative_type: creativeType,
          status: 'pending',
          batch_id: batchId ?? null,
        })
      }
    }
  }

  if (rows.length === 0) {
    console.log('[enqueueGeneration] scope matched 0 jobs — nothing to enqueue')
    return 0
  }

  if (rows.length > MAX_JOBS_PER_ENQUEUE) {
    throw new Error(
      `This would enqueue ${rows.length.toLocaleString()} jobs, over the ${MAX_JOBS_PER_ENQUEUE.toLocaleString()} limit. ` +
      `Narrow the scope — a specific option value, "First pose only", or a product filter — and try again.`
    )
  }

  console.log(`[enqueueGeneration] fan-out: ${productIds.length} products → ${rows.length} variant×image jobs`)
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

interface ImageRow {
  id: string
  product_id: string
  position: number | null
  is_primary: boolean | null
  variant_ids: string[] | null
}

/**
 * Narrow a variant list down to the ones matching a named option's value.
 *
 * Prefers the NAMED column: products.option{1,2,3}_name records which
 * position is "Size" for that product (see migration 008), so filtering by
 * name doesn't rely on every product using the same option order.
 *
 * Falls back to checking all three positions for any product with no name
 * recorded — pre-migration-008 data, until the next sync. Case-insensitive on
 * both name and value, since merchants are inconsistent about casing
 * ("Size"/"size", "M"/"m").
 */
async function filterVariantsByOption<
  T extends { product_id: string; option1: string | null; option2: string | null; option3: string | null }
>(
  variants: T[],
  productIds: string[],
  option: { name: string; value: string },
  supabase: SupabaseClient
): Promise<T[]> {
  const { data: products, error } = await supabase
    .from('products')
    .select('id, option1_name, option2_name, option3_name')
    .in('id', productIds)

  if (error) {
    console.warn('[enqueueGeneration] option-name lookup failed, matching value against every position:', error.message)
  }

  const wantName = option.name.trim().toLowerCase()
  const wantValue = option.value.trim().toLowerCase()

  const columnByProduct = new Map<string, 'option1' | 'option2' | 'option3' | null>()
  for (const p of products ?? []) {
    const names = [(p as any).option1_name, (p as any).option2_name, (p as any).option3_name]
    const idx = names.findIndex(n => typeof n === 'string' && n.trim().toLowerCase() === wantName)
    columnByProduct.set((p as any).id, idx === 0 ? 'option1' : idx === 1 ? 'option2' : idx === 2 ? 'option3' : null)
  }

  return variants.filter(v => {
    const column = columnByProduct.get(v.product_id)
    if (column) return (v[column] ?? '').trim().toLowerCase() === wantValue
    // No name recorded for this product — bridge fallback, see migration 008.
    return [v.option1, v.option2, v.option3].some(
      val => (val ?? '').trim().toLowerCase() === wantValue
    )
  })
}

/** All images for the given products, keyed by product_id. */
async function loadImagesByProduct(
  productIds: string[],
  supabase: SupabaseClient
): Promise<Map<string, ImageRow[]>> {
  const { data, error } = await supabase
    .from('product_images')
    .select('id, product_id, position, is_primary, variant_ids')
    .in('product_id', productIds)
    .order('position', { ascending: true })

  if (error) {
    console.warn('[enqueueGeneration] image lookup failed, jobs will carry no image_id:', error.message)
    return new Map()
  }

  const byProduct = new Map<string, ImageRow[]>()
  for (const row of (data ?? []) as ImageRow[]) {
    const list = byProduct.get(row.product_id) ?? []
    list.push(row)
    byProduct.set(row.product_id, list)
  }
  return byProduct
}

/**
 * Which images a variant should generate from, per the image scope.
 *
 * Mirrors the fallback already used on the product/variant detail page and
 * the Meta feed: a variant-specific image (Shopify's `variant.image`) wins
 * when Shopify recorded one, but most catalogs never assign images per
 * variant, so every variant falls back to the product's full image set.
 */
function imagesForVariant(
  productImages: ImageRow[],
  shopifyVariantId: string,
  imageScope: 'all' | 'first'
): ImageRow[] {
  const assigned = productImages.filter(img => (img.variant_ids ?? []).includes(shopifyVariantId))
  const pool = assigned.length > 0 ? assigned : productImages
  if (pool.length === 0) return []

  if (imageScope === 'all') return pool

  // 'first': the primary image if one is flagged, else whatever sorts first —
  // this is the same image runJob would have picked implicitly before jobs
  // carried an explicit image_id.
  return [pool.find(img => img.is_primary) ?? pool[0]]
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
          product_images(id, src, cloudinary_url, is_primary)`)
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
    // 'skipped', not 'completed'. Nothing was generated, and calling that
    // completed made a stale worker indistinguishable from real success: 303
    // jobs reported completed while producing zero creatives, because the
    // deployed worker predated the multi-condition resolver and could not match
    // a rule defined by `conditions`. Nothing filters generation_jobs on
    // 'completed', so this is safe and makes the outcome countable.
    await supabase.from('generation_jobs')
      .update({ status: 'skipped', error: 'no matching rule', updated_at: new Date().toISOString() })
      .eq('id', job.id)
    return
  }
  const canvasData = await getTemplateCanvas(templateId, supabase, context)

  // Composite from the image THIS JOB was fanned out for, when the enqueue
  // step recorded one — falling back to primary/first for jobs enqueued
  // before image scoping existed, or the rare no-variant legacy path.
  // Without this, every job rendered the primary photo regardless of
  // job.image_id, making the "all poses" scope a no-op at render time even
  // though the fan-out had correctly created one job per image.
  const images = (product as any).product_images || []
  const chosenImage =
    ((job as any).image_id && images.find((i: any) => i.id === (job as any).image_id)) ||
    images.find((i: any) => i.is_primary) ||
    images[0]
  const imageUrl: string | null = chosenImage?.cloudinary_url || chosenImage?.src || null

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

  // Load this job's variant, when it has one. Its price/sku/stock override the
  // product-level values so the creative shows the numbers for the exact
  // variant being advertised.
  let variant: any = null
  if ((job as any).variant_id) {
    const { data } = await supabase
      .from('product_variants')
      .select('id, title, sku, price, compare_at_price, inventory_quantity, is_sold_out, option1, option2, option3')
      .eq('id', (job as any).variant_id)
      .single()
    variant = data ?? null
  }

  const buffer = await compositeImage(canvasData as any, {
    title:           product.title,
    price:           variant?.price ?? product.price,
    compare_at_price: variant?.compare_at_price ?? product.compare_at_price,
    vendor:          product.vendor,
    product_type:    product.product_type,
    imageUrl,
    // v2 variant context — drives dynamic fields and conditional badges.
    sku:                variant?.sku ?? (product as any).sku ?? null,
    variant_title:      variant?.title ?? null,
    inventory_quantity: variant?.inventory_quantity ?? null,
    is_sold_out:        variant?.is_sold_out ?? null,
    option1:            variant?.option1 ?? null,
    option2:            variant?.option2 ?? null,
    option3:            variant?.option3 ?? null,
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

  // Variant AND image id are part of the public_id: without the variant id,
  // every variant of a product renders to the same Cloudinary asset; without
  // the image id, generating "all poses" for one variant would have every
  // image overwrite the last, leaving one creative where there should be
  // several.
  const publicId = [
    'product', product.id,
    variant?.id ?? null,
    chosenImage?.id ?? null,
    templateId, job.creative_type,
  ].filter(Boolean).join('_')
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

  // Mirror into the v2 table the products UI and Meta feed read from.
  // imageId is the image ACTUALLY used (chosenImage), not just job.image_id —
  // a legacy job with no image_id still resolved to a real photo above, and
  // that is what the uniqueness in recordCreative needs to key on.
  await recordCreative({
    supabase,
    storeId: job.store_id,
    productId: product.id,
    variantId: (job as any).variant_id ?? null,
    imageId: chosenImage?.id ?? null,
    templateId,
    jobId: job.id,
    url: deliveredUrl,
    cloudinaryId: cloudPublicId,
  })

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