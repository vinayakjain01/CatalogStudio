import { createClient as createSupabaseAdmin, SupabaseClient } from '@supabase/supabase-js'
import { resolveTemplateForProduct } from '@/lib/template-resolver'
import { compositeImage } from '@/lib/compositor'
import { uploadBuffer } from '@/lib/cloudinary'

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
  const { error, count } = await supabase
    .from('generation_jobs')
    .insert(rows, { count: 'exact' })
  if (error) throw new Error(error.message)
  return count ?? rows.length
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
  const { data: jobs, error } = await supabase.rpc('claim_generation_jobs', {
    batch_size: batchSize,
  })
  if (error) throw new Error(error.message)
  if (!jobs || jobs.length === 0) return { claimed: 0, completed: 0, failed: 0 }

  let completed = 0
  let failed = 0

  // simple promise pool
  const queue = [...jobs]
  async function worker() {
    while (queue.length) {
      const job = queue.shift()!
      try {
        await runJob(job, supabase)
        completed++
      } catch (err: any) {
        failed++
        await failJob(job, err.message, supabase)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker))

  return { claimed: jobs.length, completed, failed }
}

async function runJob(job: any, supabase: SupabaseClient) {
  // Load product + image
  const { data: product } = await supabase
    .from('products')
    .select(`id, title, vendor, product_type, tags, price, compare_at_price,
      product_images(src, is_primary)`)
    .eq('id', job.product_id)
    .single()
  if (!product) throw new Error('Product not found')

  // Resolve template (or use the one pinned on the job)
  const templateId = job.template_id || await resolveTemplateForProduct(
    {
      id: product.id,
      tags: product.tags || [],
      vendor: product.vendor,
      product_type: product.product_type,
      price: product.price,
      compare_at_price: product.compare_at_price,
    },
    job.store_id
  )
  if (!templateId) {
    // No rule matched — mark completed-with-no-op so it doesn't retry forever.
    await supabase.from('generation_jobs')
      .update({ status: 'completed', error: 'no matching rule', updated_at: new Date().toISOString() })
      .eq('id', job.id)
    return
  }

  const { data: template } = await supabase
    .from('templates').select('canvas_data').eq('id', templateId).single()
  if (!template) throw new Error('Template not found')

  const images = (product as any).product_images || []
  const primary = images.find((i: any) => i.is_primary) || images[0]

  const buffer = await compositeImage(template.canvas_data as any, {
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
  const { deliveredUrl, publicId: cloudPublicId } = await uploadBuffer(buffer, publicId)

  await supabase.from('generated_images').upsert(
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
  )

  await supabase.from('generation_jobs')
    .update({ status: 'completed', updated_at: new Date().toISOString() })
    .eq('id', job.id)
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