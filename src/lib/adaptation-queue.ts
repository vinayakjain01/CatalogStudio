/**
 * Template Adaptation — job/image orchestration.
 *
 * Mirrors generation-queue.ts's shape: DB is always the source of truth,
 * BullMQ push is best-effort, and a DB-poll fallback (processAdaptationBatch,
 * wired into catalog-worker.ts) guarantees jobs still complete when Redis is
 * unreachable.
 *
 * One adaptation_jobs row = "1 reference ad + N merchant product photos".
 * One adaptation_images row per product photo = the actual unit of
 * status/retry — a crash, timeout, or exhausted retry on image #3 never
 * touches images #1/#2/#4-10's rows, statuses, or Cloudinary uploads.
 */

import { SupabaseClient } from '@supabase/supabase-js'
import { getAdminClient } from '@/lib/generation-queue'
import { mapWithConcurrency } from '@/lib/concurrency'
import { measureAsync, logPerf } from '@/lib/perf'
import { uploadBuffer, deleteImage } from '@/lib/cloudinary'
import { enqueueAdaptationImages, redisQueuesEnabled, getCatalogQueue } from '@/lib/queues'
import { adaptProductImage, toEditInputUrl } from '@/lib/image-editing'
import { buildAdaptationPrompt, PROMPT_VERSION } from '@/lib/image-editing/prompt-builder'
import type { AdaptationJob, AdaptationImage, PlatformContext } from '@/types/template-adaptation'

export { getAdminClient }

const OUTPUT_FOLDER = 'template-adaptations'

// ── Job creation ───────────────────────────────────────────────────────────

export interface CreateAdaptationJobArgs {
  storeId: string
  userId: string
  referenceImageUrl: string
  referenceCloudinaryId?: string | null
  platformContext?: PlatformContext
  merchantNotes?: string
  productImages: { url: string; cloudinaryId?: string | null }[]
  /** BullMQ priority for this batch's images. Lower = processed sooner. */
  basePriority?: number
}

/**
 * Insert one adaptation_jobs row + one adaptation_images row per product
 * photo, then push to BullMQ if Redis is configured. Idempotent-ish: each
 * call always creates a fresh job (no upsert) — re-submitting the same
 * reference+products creates an independent job, matching how re-enqueuing
 * products in the main generation pipeline creates new generation_jobs rows.
 */
export async function createAdaptationJob(
  args: CreateAdaptationJobArgs,
  supabase: SupabaseClient = getAdminClient()
): Promise<{ jobId: string; imageIds: string[] }> {
  const {
    storeId, userId, referenceImageUrl, referenceCloudinaryId,
    platformContext = 'generic', merchantNotes, productImages, basePriority = 100,
  } = args

  if (productImages.length === 0) throw new Error('At least one product image is required')

  const { data: job, error: jobError } = await supabase
    .from('adaptation_jobs')
    .insert({
      store_id: storeId,
      user_id: userId,
      reference_image_url: referenceImageUrl,
      reference_cloudinary_id: referenceCloudinaryId ?? null,
      platform_context: platformContext,
      merchant_notes: merchantNotes?.trim() || null,
      status: 'pending',
      total_images: productImages.length,
    })
    .select('id')
    .single()

  if (jobError) throw new Error(jobError.message)
  const jobId = job.id as string

  const rows = productImages.map((img, i) => ({
    job_id: jobId,
    store_id: storeId,
    position: i,
    product_image_url: img.url,
    product_image_cloudinary_id: img.cloudinaryId ?? null,
    status: 'pending',
  }))

  const { data: images, error: imagesError } = await supabase
    .from('adaptation_images')
    .insert(rows)
    .select('id')

  if (imagesError) {
    // Roll back the parent row rather than leaving an orphaned "pending,
    // 0 images" job that would never reach a terminal status.
    await supabase.from('adaptation_jobs').delete().eq('id', jobId)
    throw new Error(imagesError.message)
  }

  const imageIds = (images || []).map((r: any) => r.id)
  console.log(`[createAdaptationJob] jobId=${jobId} storeId=${storeId} images=${imageIds.length}`)

  if (redisQueuesEnabled()) {
    try {
      await enqueueAdaptationImages(imageIds, basePriority)
    } catch (err) {
      console.error('[createAdaptationJob] Redis enqueue failed; DB-poll fallback will still pick these up:', err)
    }
  } else {
    console.warn('[createAdaptationJob] REDIS_URL not set — images are in DB only, DB-poll fallback will process them')
  }

  return { jobId, imageIds }
}

// ── Per-image processing ────────────────────────────────────────────────────

type JobContext = {
  jobsById: Map<string, Promise<AdaptationJob>>
}

function createJobContext(): JobContext {
  return { jobsById: new Map() }
}

function getJob(jobId: string, supabase: SupabaseClient, context: JobContext): Promise<AdaptationJob> {
  const cached = context.jobsById.get(jobId)
  if (cached) return cached
  const promise = (async () => {
    const { data, error } = await supabase
      .from('adaptation_jobs')
      .select('*')
      .eq('id', jobId)
      .single()
    if (error) throw new Error(error.message)
    if (!data) throw new Error('Adaptation job not found')
    return data as AdaptationJob
  })()
  context.jobsById.set(jobId, promise)
  return promise
}

/** Assumes `image` has already been claimed (status='generating', locked_at set). */
async function runAdaptationImage(image: AdaptationImage, supabase: SupabaseClient, context: JobContext) {
  const started = Date.now()
  const job = await getJob(image.job_id, supabase, context)

  const prompt = buildAdaptationPrompt({
    platformContext: job.platform_context,
    merchantNotes: job.merchant_notes ?? undefined,
  })

  const result = await measureAsync(
    'image_editing.adapt_product_image',
    () => adaptProductImage({
      templateImageUrl: toEditInputUrl(job.reference_image_url),
      productImageUrl: toEditInputUrl(image.product_image_url),
      systemPrompt: prompt,
    }),
    { jobId: job.id, imageId: image.id }
  )

  const publicId = `adaptation_${image.job_id}_${image.id}`
  const { deliveredUrl, publicId: cloudPublicId } = await measureAsync(
    'cloudinary.upload',
    () => uploadBuffer(result.buffer, publicId, OUTPUT_FOLDER),
    { imageId: image.id, bytes: result.buffer.length }
  )

  const generationMs = Date.now() - started

  const { error: updateError } = await supabase
    .from('adaptation_images')
    .update({
      status: 'completed',
      output_url: deliveredUrl,
      output_cloudinary_id: cloudPublicId,
      provider: result.provider,
      prompt_version: PROMPT_VERSION,
      generation_ms: generationMs,
      locked_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', image.id)

  if (updateError) throw new Error(updateError.message)

  logPerf('adaptation.image_total', generationMs, { jobId: job.id, imageId: image.id, provider: result.provider })
}

async function failAdaptationImage(image: AdaptationImage, message: string, supabase: SupabaseClient) {
  // Re-read current attempts — may have been incremented at claim time.
  const { data: current } = await supabase
    .from('adaptation_images')
    .select('attempts, max_attempts')
    .eq('id', image.id)
    .maybeSingle()

  const attempts = current?.attempts ?? image.attempts
  const maxAttempts = current?.max_attempts ?? image.max_attempts
  const willRetry = attempts < maxAttempts

  await supabase
    .from('adaptation_images')
    .update({
      status: willRetry ? 'pending' : 'failed',
      locked_at: null,
      error: message?.slice(0, 500),
      updated_at: new Date().toISOString(),
    })
    .eq('id', image.id)

  if (!willRetry) {
    console.warn(`[adaptation-queue] Image permanently failed after ${attempts}/${maxAttempts} attempts: ${image.id}`)
  }
}

/**
 * Claim and process ONE adaptation_images row by id. Used by the BullMQ
 * worker (one image = one BullMQ job, payload { imageId }).
 */
export async function processAdaptationImage(
  imageId: string,
  supabase: SupabaseClient = getAdminClient()
): Promise<{ processed: boolean; completed: boolean; failed: boolean }> {
  const { data: image, error } = await supabase
    .from('adaptation_images')
    .update({ status: 'generating', locked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', imageId)
    .eq('status', 'pending')
    .select('*')
    .maybeSingle()

  if (error) throw new Error(error.message)
  if (!image) {
    console.warn(`[processAdaptationImage] Image not claimable imageId=${imageId} — skipping`)
    return { processed: false, completed: false, failed: false }
  }

  await supabase.rpc('increment_adaptation_image_attempts', { image_ids: [imageId] }).throwOnError()

  const context = createJobContext()
  try {
    await runAdaptationImage(image as AdaptationImage, supabase, context)
    await syncJobAggregate(image.job_id, supabase)
    return { processed: true, completed: true, failed: false }
  } catch (err: any) {
    console.error(`[processAdaptationImage] Failed imageId=${imageId}:`, err.message)
    await failAdaptationImage(image as AdaptationImage, err.message, supabase)
    await syncJobAggregate(image.job_id, supabase)
    return { processed: true, completed: false, failed: true }
  }
}

/**
 * Claim and process up to `batchSize` pending adaptation_images rows
 * directly from the DB. The Vercel-cannot-reach-Redis fallback path —
 * mirrors generation-queue.ts's processBatch().
 */
export async function processAdaptationBatch(
  batchSize = 10,
  concurrency = 3,
  supabase: SupabaseClient = getAdminClient()
): Promise<{ claimed: number; completed: number; failed: number }> {
  const { data: pending, error: selectError } = await supabase
    .from('adaptation_images')
    .select('id')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(batchSize)

  if (selectError) throw new Error(selectError.message)
  if (!pending || pending.length === 0) return { claimed: 0, completed: 0, failed: 0 }

  const ids = pending.map((r: any) => r.id)

  const { data: claimed, error: claimError } = await supabase
    .from('adaptation_images')
    .update({ status: 'generating', locked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .in('id', ids)
    .eq('status', 'pending')
    .select('*')

  if (claimError) throw new Error(claimError.message)
  if (!claimed || claimed.length === 0) return { claimed: 0, completed: 0, failed: 0 }

  const claimedIds = claimed.map((r: any) => r.id)
  await supabase.rpc('increment_adaptation_image_attempts', { image_ids: claimedIds }).throwOnError()

  let completed = 0
  let failed = 0
  const context = createJobContext()
  const affectedJobIds = new Set<string>()

  await mapWithConcurrency(claimed, concurrency, async image => {
    affectedJobIds.add(image.job_id)
    try {
      await runAdaptationImage(image as AdaptationImage, supabase, context)
      completed++
    } catch (err: any) {
      failed++
      console.error(`[processAdaptationBatch] Image failed imageId=${image.id}:`, err.message)
      await failAdaptationImage(image as AdaptationImage, err.message, supabase)
    }
  })

  await Promise.all([...affectedJobIds].map(jobId => syncJobAggregate(jobId, supabase)))

  return { claimed: claimed.length, completed, failed }
}

// ── Retry / cancel ───────────────────────────────────────────────────────────

export async function retryAdaptationImage(
  imageId: string,
  supabase: SupabaseClient = getAdminClient()
): Promise<void> {
  const { data: image, error } = await supabase
    .from('adaptation_images')
    .update({
      status: 'pending',
      attempts: 0,
      error: null,
      locked_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', imageId)
    .select('id, job_id')
    .single()

  if (error) throw new Error(error.message)

  if (redisQueuesEnabled()) {
    try {
      await enqueueAdaptationImages([imageId])
    } catch (err) {
      console.error('[retryAdaptationImage] Redis enqueue failed; DB-poll fallback will still pick this up:', err)
    }
  }

  await syncJobAggregate(image.job_id, supabase)
}

export async function cancelAdaptationJob(
  jobId: string,
  supabase: SupabaseClient = getAdminClient()
): Promise<{ cancelled: number }> {
  const { data: images, error } = await supabase
    .from('adaptation_images')
    .select('id')
    .eq('job_id', jobId)
    .in('status', ['pending', 'generating'])

  if (error) throw new Error(error.message)
  const imageIds = (images || []).map((r: any) => r.id)

  if (imageIds.length > 0) {
    await supabase
      .from('adaptation_images')
      .update({ status: 'cancelled', locked_at: null, updated_at: new Date().toISOString() })
      .in('id', imageIds)

    // Best-effort: only waiting/delayed BullMQ jobs are safely removable —
    // active jobs are mid-flight (matches /api/generate/cancel's approach).
    try {
      const queue = getCatalogQueue('templateAdaptation')
      if (queue) {
        await Promise.allSettled(
          imageIds.map(async (id: string) => {
            const bullJob = await queue.getJob(`adaptation:${id}`)
            if (bullJob) {
              const state = await bullJob.getState()
              if (state === 'waiting' || state === 'delayed') await bullJob.remove()
            }
          })
        )
      }
    } catch (err) {
      console.warn('[cancelAdaptationJob] Redis job removal partial/failed (DB is source of truth):', err)
    }
  }

  await syncJobAggregate(jobId, supabase)
  return { cancelled: imageIds.length }
}

// ── Aggregate sync ───────────────────────────────────────────────────────────

/**
 * Recomputes (never delta-increments) total_images/completed_count/
 * failed_count/status from a fresh COUNT over adaptation_images — safe
 * under concurrent workers finishing different images of the same job at
 * the same time, and keeps total_images accurate if a single image is ever
 * deleted (see deleteAdaptationImage below).
 */
async function syncJobAggregate(jobId: string, supabase: SupabaseClient): Promise<void> {
  const { data: images, error } = await supabase
    .from('adaptation_images')
    .select('status')
    .eq('job_id', jobId)

  if (error) {
    console.error(`[syncJobAggregate] Failed to load images for jobId=${jobId}:`, error.message)
    return
  }

  const rows = images || []
  const total = rows.length
  const completedCount = rows.filter((r: any) => r.status === 'completed').length
  const failedCount = rows.filter((r: any) => r.status === 'failed').length
  const cancelledCount = rows.filter((r: any) => r.status === 'cancelled').length
  const activeCount = rows.filter((r: any) => r.status === 'pending' || r.status === 'generating').length

  let status: string
  if (total === 0) {
    status = 'pending'
  } else if (activeCount > 0) {
    status = 'processing'
  } else if (completedCount === total) {
    status = 'completed'
  } else if (completedCount === 0 && failedCount + cancelledCount === total) {
    status = failedCount > 0 ? 'failed' : 'cancelled'
  } else {
    status = 'partial'
  }

  await supabase
    .from('adaptation_jobs')
    .update({
      total_images: total,
      completed_count: completedCount,
      failed_count: failedCount,
      status,
      updated_at: new Date().toISOString(),
    })
    .eq('id', jobId)
}

// ── Deletion (Cloudinary cleanup + row removal) ─────────────────────────────

/** Best-effort Cloudinary destroy — never throws, matches creatives/[creativeId]'s convention. */
async function safeDeleteImage(publicId: string | null | undefined) {
  if (!publicId) return
  try {
    await deleteImage(publicId)
  } catch {
    // best-effort — Cloudinary cleanup failures should never block a DB delete
  }
}

/**
 * Delete a single adaptation_images row (and its Cloudinary output/product
 * assets) without touching sibling images or the parent job row. Re-syncs
 * the parent job's total_images/counts/status afterward.
 */
export async function deleteAdaptationImage(
  imageId: string,
  supabase: SupabaseClient = getAdminClient()
): Promise<void> {
  const { data: image, error } = await supabase
    .from('adaptation_images')
    .select('job_id, output_cloudinary_id')
    .eq('id', imageId)
    .single()

  if (error) throw new Error(error.message)
  if (!image) return

  await safeDeleteImage(image.output_cloudinary_id)

  const { error: deleteError } = await supabase.from('adaptation_images').delete().eq('id', imageId)
  if (deleteError) throw new Error(deleteError.message)

  await syncJobAggregate(image.job_id, supabase)
}

/**
 * Delete an entire adaptation_jobs row: best-effort Cloudinary cleanup of the
 * reference ad + every image's output, then delete the job (cascades to
 * adaptation_images via the FK's ON DELETE CASCADE).
 */
export async function deleteAdaptationJob(
  jobId: string,
  supabase: SupabaseClient = getAdminClient()
): Promise<void> {
  const [{ data: job }, { data: images }] = await Promise.all([
    supabase.from('adaptation_jobs').select('reference_cloudinary_id').eq('id', jobId).maybeSingle(),
    supabase.from('adaptation_images').select('output_cloudinary_id').eq('job_id', jobId),
  ])

  await Promise.all([
    safeDeleteImage(job?.reference_cloudinary_id),
    ...(images || []).map((img: any) => safeDeleteImage(img.output_cloudinary_id)),
  ])

  const { error } = await supabase.from('adaptation_jobs').delete().eq('id', jobId)
  if (error) throw new Error(error.message)
}
