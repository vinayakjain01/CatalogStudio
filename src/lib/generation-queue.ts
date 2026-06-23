import { createClient as createSupabaseAdmin, SupabaseClient } from '@supabase/supabase-js'
import {
  getActiveTemplateRules,
  resolveTemplateFromRules,
  TemplateRule,
} from '@/lib/template-resolver'
import { compositeImage } from '@/lib/compositor'
import { uploadBuffer } from '@/lib/cloudinary'
import { mapWithConcurrency } from '@/lib/concurrency'
import { logPerf, measureAsync } from '@/lib/perf'
import { enqueueGenerationJobs, redisQueuesEnabled } from '@/lib/queues'

export function getAdminClient(): SupabaseClient {
  return createSupabaseAdmin(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

export interface EnqueueArgs {
  storeId: string
  productIds: string[]      // internal product UUIDs
  creativeType?: string     // default 'default'
  batchId?: string
}

/**
 * Enqueue one generation job per product. Idempotent-ish: callers that re-enqueue
 * the same product create a new job row; the worker upserts the resulting creative
 * by (product, template, creative_type), so duplicates collapse at write time.
 */
export async function enqueueGeneration(
  { storeId, productIds, creativeType = 'default', batchId }: EnqueueArgs,
  supabase: SupabaseClient = getAdminClient()
): Promise<number> {
  if (productIds.length === 0) return 0
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
  if (error) throw new Error(error.message)

  if (redisQueuesEnabled()) {
    try {
      await measureAsync(
        'queue.generation.redis_enqueue',
        () => enqueueGenerationJobs((data || []).map((row: any) => row.id)),
        { rows: data?.length || 0, storeId }
      )
    } catch (err) {
      console.error('[queue] Redis enqueue failed; DB queue remains available:', err)
    }
  }

  return data?.length ?? rows.length
}

/**
 * Claim and process up to `batchSize` jobs. Returns counts. Designed to be
 * called repeatedly by a cron tick; each call is bounded so it fits inside a
 * serverless function timeout.
 *
 * Concurrency: we process the claimed batch with limited parallelism so a few
 * slow image loads don't serialize the whole batch, while not hammering
 * Cloudinary/remote hosts.
 */
export async function processBatch(
  batchSize = 10,
  concurrency = 4,
  supabase: SupabaseClient = getAdminClient()
): Promise<{ claimed: number; completed: number; failed: number }> {
  const { data: jobs, error } = await measureAsync(
    'queue.generation.claim_batch',
    () => supabase.rpc('claim_generation_jobs', { batch_size: batchSize }),
    { batchSize }
  )
  if (error) throw new Error(error.message)
  if (!jobs || jobs.length === 0) return { claimed: 0, completed: 0, failed: 0 }

  let completed = 0
  let failed = 0
  const context = createJobContext()

  await mapWithConcurrency(jobs, concurrency, async job => {
    try {
      await runJob(job, supabase, context)
      completed++
    } catch (err: any) {
      failed++
      await failJob(job, err.message, supabase)
    }
  })

  return { claimed: jobs.length, completed, failed }
}

export async function processGenerationJob(
  jobId: string,
  supabase: SupabaseClient = getAdminClient()
): Promise<{ processed: boolean; completed: boolean; failed: boolean }> {
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

  if (error) throw new Error(error.message)
  if (!job) return { processed: false, completed: false, failed: false }

  try {
    await runJob(job, supabase, createJobContext())
    return { processed: true, completed: true, failed: false }
  } catch (err: any) {
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
  // Load product + image
  const { data: product, error: productError } = await measureAsync(
    'supabase.products.load_for_generation',
    () => supabase
      .from('products')
      .select(`id, title, vendor, product_type, tags, price, compare_at_price,
        product_images(src, is_primary)`)
      .eq('id', job.product_id)
      .single(),
    { productId: job.product_id }
  )
  if (productError) throw new Error(productError.message)
  if (!product) throw new Error('Product not found')

  // Resolve template (or use the one pinned on the job)
  const templateId = job.template_id || resolveTemplateFromRules(
    {
      id: product.id,
      tags: product.tags || [],
      vendor: product.vendor,
      product_type: product.product_type,
      price: product.price,
      compare_at_price: product.compare_at_price,
    },
    await getRulesForStore(job.store_id, context)
  )
  if (!templateId) {
    // No rule matched — mark completed-with-no-op so it doesn't retry forever.
    await supabase.from('generation_jobs')
      .update({ status: 'completed', error: 'no matching rule', updated_at: new Date().toISOString() })
      .eq('id', job.id)
    return
  }

  const canvasData = await getTemplateCanvas(templateId, supabase, context)

  const images = (product as any).product_images || []
  const primary = images.find((i: any) => i.is_primary) || images[0]

  const buffer = await compositeImage(canvasData as any, {
    title: product.title,
    price: product.price,
    compare_at_price: product.compare_at_price,
    vendor: product.vendor,
    product_type: product.product_type,
    imageUrl: primary?.src || null,
  })

  // PNG master sanity check (0x89 0x50 'PNG')
  if (buffer.length < 1000 || buffer[0] !== 0x89 || buffer[1] !== 0x50) {
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
        product_id: product.id,
        template_id: templateId,
        creative_type: job.creative_type,
        cloudinary_public_id: cloudPublicId,
        generated_url: deliveredUrl,
        status: 'completed',
        updated_at: new Date().toISOString(),
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
  const willRetry = job.attempts < job.max_attempts
  await supabase.from('generation_jobs')
    .update({
      status: willRetry ? 'pending' : 'failed',  // back to pending for retry
      locked_at: null,
      error: message?.slice(0, 500),
      updated_at: new Date().toISOString(),
    })
    .eq('id', job.id)
}
