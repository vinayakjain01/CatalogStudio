import { createClient as createSupabaseAdmin, SupabaseClient } from '@supabase/supabase-js'
import { resolveTemplateForProduct } from '@/lib/template-resolver'
import { compositeImage } from '@/lib/compositor'
import { uploadBuffer } from '@/lib/cloudinary'

function getAdminClient(): SupabaseClient {
  return createSupabaseAdmin(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

export type JobStatus = 'queued' | 'processing' | 'completed' | 'failed'

export interface GenerationInput {
  jobId: string
  productId: string
  storeId: string
  templateId?: string | null
}

/** Patch a generation_jobs row (admin client; bypasses RLS). */
export async function markJobStatus(
  jobId: string,
  status: JobStatus,
  extra: Record<string, unknown> = {}
): Promise<void> {
  const supabase = getAdminClient()
  await supabase
    .from('generation_jobs')
    .update({ status, ...extra })
    .eq('id', jobId)
}

/**
 * Render one product creative and persist it. Pure work: resolves the template
 * (via the rules engine unless one is supplied), composites the image, uploads
 * the lossless master to Cloudinary, and upserts `generated_images`. Throws on
 * any failure so the caller (worker or inline path) can record it.
 */
export async function processGeneration(
  input: GenerationInput
): Promise<{ url: string; templateId: string }> {
  const supabase = getAdminClient()

  const { data: product } = await supabase
    .from('products')
    .select('id, title, vendor, product_type, tags, price, compare_at_price, product_images(src, is_primary)')
    .eq('id', input.productId)
    .eq('store_id', input.storeId)
    .single()

  if (!product) throw new Error('Product not found')

  const templateId =
    input.templateId ||
    (await resolveTemplateForProduct(
      {
        id: product.id,
        tags: product.tags || [],
        vendor: product.vendor,
        product_type: product.product_type,
        price: product.price,
        compare_at_price: product.compare_at_price,
      },
      input.storeId
    ))

  if (!templateId) throw new Error('No matching rule found for this product')

  const { data: template } = await supabase
    .from('templates')
    .select('canvas_data')
    .eq('id', templateId)
    .single()

  if (!template) throw new Error('Template not found')

  const images = (product as { product_images?: { src: string; is_primary: boolean }[] }).product_images || []
  const primaryImage = images.find((i) => i.is_primary) || images[0]

  const buffer = await compositeImage(template.canvas_data as never, {
    title: product.title,
    price: product.price,
    compare_at_price: product.compare_at_price,
    vendor: product.vendor,
    product_type: product.product_type,
    imageUrl: primaryImage?.src || null,
  })

  // The compositor returns a lossless PNG; verify the PNG magic bytes (89 50).
  if (buffer.length < 1000 || buffer[0] !== 0x89 || buffer[1] !== 0x50) {
    throw new Error('Image generation produced an invalid buffer (canvas unsupported on this runtime)')
  }

  const publicId = `product_${product.id}_${templateId}`
  const { deliveredUrl: url, publicId: cloudPublicId } = await uploadBuffer(buffer, publicId)

  await supabase.from('generated_images').upsert(
    {
      product_id: product.id,
      template_id: templateId,
      cloudinary_public_id: cloudPublicId,
      generated_url: url,
      status: 'completed',
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'product_id,template_id' }
  )

  return { url, templateId }
}

/**
 * Run a job inline (no Redis) with full status lifecycle. Used by the enqueue
 * endpoint when the queue is disabled. Never throws — records failure instead.
 */
export async function runGenerationInline(input: GenerationInput): Promise<void> {
  await markJobStatus(input.jobId, 'processing', { started_at: new Date().toISOString() })
  try {
    const { url, templateId } = await processGeneration(input)
    await markJobStatus(input.jobId, 'completed', {
      progress: 100,
      template_id: templateId,
      generated_url: url,
      completed_at: new Date().toISOString(),
    })
  } catch (err) {
    await markJobStatus(input.jobId, 'failed', {
      error: err instanceof Error ? err.message : 'Generation failed',
      completed_at: new Date().toISOString(),
    })
  }
}
