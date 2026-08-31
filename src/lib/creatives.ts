/**
 * @module creatives
 *
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
 *
 * RESPONSIBILITIES:
 *   - recordCreative — delete-then-insert one row into generated_creatives.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AssetType } from '@/types/template'

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
  /**
   * Which placement this creative is for. Part of the match/identity key
   * (see the class doc below) — without it, generating a 'feed' creative for
   * a variant would delete-then-overwrite that variant's existing 'catalog'
   * creative, silently emptying the live Meta feed's image_link for it.
   */
  assetType?: AssetType
}

/**
 * Upsert one creative into `generated_creatives`.
 *
 * Delete-then-insert rather than upsert: the table's uniqueness is enforced by
 * a PARTIAL index (variant_id, image_id, template_id) WHERE variant_id IS NOT
 * NULL, and Postgres cannot infer a partial index as an ON CONFLICT target
 * through PostgREST. Deleting the matching row first gives the same
 * "regeneration replaces, never accumulates" behaviour, and matches how
 * product_images is already maintained elsewhere in this codebase.
 *
 * image_id is part of the match, not just variant_id: the "all poses" scope
 * generates one creative per image for the same variant, and matching on
 * variant_id alone would delete the previous image's row on every subsequent
 * insert — leaving only the last image's creative behind.
 *
 * asset_type is part of the match too, for the same reason: without it,
 * generating a 'feed' or 'story' creative for a variant that already has a
 * 'catalog' one would delete the catalog row first, since product_id +
 * template_id + variant_id + image_id alone doesn't distinguish placements —
 * emptying the live Meta feed's image_link for that variant every time an ad
 * placement is generated for it. Kept as an explicit delete-then-insert
 * (not upsert) matching migration 009's unique index — that index is still a
 * PARTIAL one (`where variant_id is not null`), which PostgREST cannot target
 * via `.upsert(..., {onConflict})` for the same reason the original
 * (variant_id, image_id, template_id) index couldn't.
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
  assetType = 'catalog',
}: RecordCreativeArgs): Promise<void> {
  try {
    let existing = supabase
      .from('generated_creatives')
      .delete()
      .eq('product_id', productId)
      .eq('template_id', templateId)
      .eq('asset_type', assetType)

    existing = variantId ? existing.eq('variant_id', variantId) : existing.is('variant_id', null)
    existing = imageId ? existing.eq('image_id', imageId) : existing.is('image_id', null)

    const { error: deleteError } = await existing

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
      asset_type: assetType,
      updated_at: new Date().toISOString(),
    })

    if (insertError) {
      console.warn('[creatives] insert failed:', insertError.message)
    }
  } catch (err: any) {
    console.warn('[creatives] record skipped:', err?.message)
  }
}
