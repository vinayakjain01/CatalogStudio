/**
 * Recording a finished creative.
 *
 * v2 reads creatives from `generated_creatives` — it carries store_id (so a
 * tenant filter needs no join through products) and variant_id (so one creative
 * per variant is representable). `generated_images` has neither.
 *
 * Both are written during the transition: the products UI and the Meta feed
 * already read the new table, while the dashboard stat cards and the creatives
 * page still read the old one. Migration 004 drops `generated_images` once
 * those last readers move, and this dual write becomes a single one.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

export interface RecordCreativeArgs {
  supabase: SupabaseClient
  storeId: string
  productId: string
  /** Null for a product-level creative — per-variant generation supplies this. */
  variantId?: string | null
  imageId?: string | null
  templateId: string
  jobId?: string | null
  url: string
  cloudinaryId?: string | null
  width?: number | null
  height?: number | null
}

/**
 * Upsert one creative into `generated_creatives`.
 *
 * Delete-then-insert rather than upsert: the table's uniqueness is enforced by
 * a PARTIAL index (variant_id, template_id) WHERE variant_id IS NOT NULL, and
 * Postgres cannot infer a partial index as an ON CONFLICT target through
 * PostgREST. Deleting the matching row first gives the same "regeneration
 * replaces, never accumulates" behaviour, and matches how product_images is
 * already maintained elsewhere in this codebase.
 *
 * Best-effort by design: a creative that rendered and uploaded successfully
 * must not be reported as a failed job because this bookkeeping row did not
 * write. The caller's own table is the authoritative record for now.
 */
export async function recordCreative({
  supabase,
  storeId,
  productId,
  variantId = null,
  imageId = null,
  templateId,
  jobId = null,
  url,
  cloudinaryId = null,
  width = null,
  height = null,
}: RecordCreativeArgs): Promise<void> {
  try {
    const existing = supabase
      .from('generated_creatives')
      .delete()
      .eq('product_id', productId)
      .eq('template_id', templateId)

    const { error: deleteError } = variantId
      ? await existing.eq('variant_id', variantId)
      : await existing.is('variant_id', null)

    if (deleteError) {
      console.warn('[creatives] delete before insert failed:', deleteError.message)
      return
    }

    const { error: insertError } = await supabase.from('generated_creatives').insert({
      store_id: storeId,
      product_id: productId,
      variant_id: variantId,
      image_id: imageId,
      template_id: templateId,
      job_id: jobId,
      cloudinary_id: cloudinaryId,
      url,
      width,
      height,
      updated_at: new Date().toISOString(),
    })

    if (insertError) {
      console.warn('[creatives] insert failed:', insertError.message)
    }
  } catch (err: any) {
    console.warn('[creatives] record skipped:', err?.message)
  }
}
