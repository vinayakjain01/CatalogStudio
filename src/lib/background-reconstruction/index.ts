/**
 * Background Reconstruction Service (Cloudinary Generative Remove)
 *
 * Opt-in companion to background-removal: instead of discarding the original
 * photo's background entirely, this reconstructs it — removing ONLY the
 * product-shaped region and inpainting it based on the surrounding pixels —
 * so the transparent cutout (produced separately, unchanged, by
 * src/lib/background-removal) can be placed back on what looks like its own
 * original backdrop instead of a synthetic solid/blur/gradient one.
 *
 * How it works:
 *  1. Detect the product's bounding box from the ALREADY-PRODUCED transparent
 *     cutout's alpha channel (reuses detectProductBounds from image-bounds.ts
 *     — the same utility Product Positioning uses, applied here for a
 *     different purpose).
 *  2. Pad that box slightly so Cloudinary sees the full object (a tight box
 *     risks leaving a sliver of the original product visible at the edges).
 *  3. Run Cloudinary's region-based Generative Remove (e_gen_remove) on the
 *     ORIGINAL (opaque) photo — NOT a text prompt, an exact pixel rectangle,
 *     since we already know precisely where the product is.
 *  4. Cache forever in background_reconstruction_cache, same convention as
 *     bg_removal_cache / image_extend_cache.
 *
 * This is a genuinely new, metered Cloudinary "Generative AI" feature —
 * separate cost from background removal or AI Extend. Every failure mode
 * here returns null rather than throwing, so callers fall back to today's
 * default (solid background) rather than breaking generation.
 *
 * Requires:
 *  - Cloudinary account with Generative Remove enabled
 *  - All existing CLOUDINARY_* env vars (already configured)
 *  - The products.background_reconstruction_cache table (manual migration —
 *    no migrations are checked into this repo, same as every other table)
 */

import crypto from 'crypto'
import { v2 as cloudinary } from 'cloudinary'
import type { SupabaseClient } from '@supabase/supabase-js'
import { detectProductBounds } from '@/lib/image-bounds'

cloudinary.config({
  cloud_name: process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
})

// ─── Cache key ────────────────────────────────────────────────────────────────

export function getReconstructionCacheKey(sourceUrl: string): string {
  return crypto.createHash('sha256').update(`${sourceUrl}|gen_remove|v1`).digest('hex')
}

// ─── Upload source image to Cloudinary ───────────────────────────────────────
// Same pattern as image-extend/index.ts's ensureOnCloudinary — kept as its
// own copy rather than a shared import, matching this codebase's convention
// of each AI-pipeline module being self-contained.

async function ensureOnCloudinary(sourceUrl: string): Promise<string> {
  const cloudName = process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME
  if (sourceUrl.includes(`res.cloudinary.com/${cloudName}`)) {
    const match = sourceUrl.match(/\/upload\/(?:v\d+\/)?(.+?)(?:\.[a-z]+)?$/)
    if (match) return match[1]
  }

  const result = await cloudinary.uploader.upload(sourceUrl, {
    folder: 'bg-reconstruction-sources',
    public_id: `src_${crypto.createHash('sha256').update(sourceUrl).digest('hex').slice(0, 16)}`,
    overwrite: false,
    resource_type: 'image',
  })
  return result.public_id
}

// ─── Region padding ───────────────────────────────────────────────────────────
// The alpha-channel bounding box can slightly under-cover the product at soft
// or anti-aliased edges. Padding the removal region prevents a visible sliver
// of the original product surviving at the boundary. This is a rectangle
// (Cloudinary's region-removal API is rectangle-only, not an arbitrary mask),
// so any real background inside the padded box that wasn't actually covered
// by the product also gets regenerated — an accepted, usually-imperceptible
// tradeoff on typical plain studio backdrops.

const REGION_PADDING_FRACTION = 0.08

// ─── Main service function ───────────────────────────────────────────────────

export interface ReconstructionResult {
  backgroundUrl: string
  cloudinaryId: string
  fromCache: boolean
}

/**
 * Get the original background with the product region removed and inpainted.
 * Returns null (never throws) on any failure — callers should fall back to
 * their existing default background rather than fail the whole generation.
 */
export async function getReconstructedBackground(
  sourceUrl: string,
  transparentCutoutUrl: string,
  storeId: string,
  supabase: SupabaseClient
): Promise<ReconstructionResult | null> {
  const cacheKey = getReconstructionCacheKey(sourceUrl)

  // 1. Check cache
  const { data: cached } = await supabase
    .from('background_reconstruction_cache')
    .select('background_url, cloudinary_id')
    .eq('cache_key', cacheKey)
    .maybeSingle()

  if (cached) {
    console.log(`[background-reconstruction] Cache HIT for ${sourceUrl.slice(0, 60)}...`)
    return { backgroundUrl: cached.background_url, cloudinaryId: cached.cloudinary_id, fromCache: true }
  }

  console.log(`[background-reconstruction] Cache MISS — running Generative Remove for ${sourceUrl.slice(0, 60)}...`)

  try {
    // 2. Detect the product's bounding box from the transparent cutout's alpha
    //    channel (the source photo itself has no alpha to detect against).
    const bounds = await detectProductBounds(transparentCutoutUrl)

    // 3. Pad the region.
    const contentW = bounds.right - bounds.left
    const contentH = bounds.bottom - bounds.top
    const padX = Math.round(contentW * REGION_PADDING_FRACTION)
    const padY = Math.round(contentH * REGION_PADDING_FRACTION)
    const regionX = Math.max(0, bounds.left - padX)
    const regionY = Math.max(0, bounds.top - padY)
    const regionRight = Math.min(bounds.imageWidth, bounds.right + padX)
    const regionBottom = Math.min(bounds.imageHeight, bounds.bottom + padY)
    const regionW = regionRight - regionX
    const regionH = regionBottom - regionY

    if (regionW <= 0 || regionH <= 0) {
      console.warn('[background-reconstruction] degenerate region, bypassing')
      return null
    }

    // 4. Ensure source is on Cloudinary, then run region-based Generative Remove.
    const publicId = await ensureOnCloudinary(sourceUrl)
    const eagerPublicId = `bg-reconstructed/${cacheKey.slice(0, 24)}`

    // Cloudinary Generative Remove, region syntax: removes the given
    // rectangle and inpaints it from the surrounding pixels. NOTE: the exact
    // transformation string below is Cloudinary's documented region syntax
    // as of this writing (e_gen_remove:region_((x_..;y_..;w_..;h_..))) —
    // verify against a live Cloudinary account before relying on this in
    // production, since generative-AI transformation syntax has changed
    // before and isn't exercised by any existing code in this repo.
    const effect = `gen_remove:region_((x_${Math.round(regionX)};y_${Math.round(regionY)};w_${Math.round(regionW)};h_${Math.round(regionH)}))`

    const uploadResult = await cloudinary.uploader.upload(sourceUrl, {
      public_id: eagerPublicId,
      folder: 'bg-reconstructed',
      overwrite: true,
      resource_type: 'image',
      eager: [{ effect, fetch_format: 'auto', quality: 'auto:best' }],
      eager_async: false, // wait for the eager transform so we can cache the final URL immediately
    })

    const eagerResult = uploadResult.eager?.[0]
    if (!eagerResult?.secure_url) {
      console.error('[background-reconstruction] Generative Remove produced no result, bypassing')
      return null
    }

    const backgroundUrl = eagerResult.secure_url
    const cloudinaryId = uploadResult.public_id

    // 5. Cache
    await supabase
      .from('background_reconstruction_cache')
      .upsert({
        cache_key: cacheKey,
        source_url: sourceUrl,
        background_url: backgroundUrl,
        cloudinary_id: cloudinaryId,
        store_id: storeId,
      }, { onConflict: 'cache_key' })

    console.log(`[background-reconstruction] Done. Reconstructed background: ${backgroundUrl}`)

    return { backgroundUrl, cloudinaryId, fromCache: false }
  } catch (err: any) {
    // Non-fatal by design — the caller falls back to the solid background.
    console.error('[background-reconstruction] Failed, bypassing:', err?.message)
    return null
  }
}

/**
 * Delete a cached entry (to force re-processing).
 */
export async function invalidateReconstructionCache(
  sourceUrl: string,
  supabase: SupabaseClient
): Promise<void> {
  const cacheKey = getReconstructionCacheKey(sourceUrl)
  const { data } = await supabase
    .from('background_reconstruction_cache')
    .select('cloudinary_id')
    .eq('cache_key', cacheKey)
    .maybeSingle()

  if (data?.cloudinary_id) {
    await cloudinary.uploader.destroy(data.cloudinary_id, { resource_type: 'image' }).catch(() => {})
  }

  await supabase
    .from('background_reconstruction_cache')
    .delete()
    .eq('cache_key', cacheKey)
}
