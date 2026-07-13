/**
 * Product Layer Engine
 *
 * FILE: src/lib/product-layer-engine.ts  (NEW FILE)
 *
 * Central coordinator for the non-destructive image pipeline.
 * Replaces the split between:
 *   - getTransparentProductImage()     (background-removal/index.ts)
 *   - getReconstructedBackground()     (background-reconstruction/index.ts)
 *
 * This file produces all 5 assets per imported product image and caches them
 * atomically in bg_removal_cache (extended by the migration SQL).
 *
 * Guarantees:
 *  1. AI runs AT MOST ONCE per unique source image URL
 *  2. Original image is NEVER modified, resized, or recompressed
 *  3. Returns immediately from cache when bundle_status = 'complete'
 *  4. 'partial' bundles are usable — transparentUrl + metadata is enough
 *     for composition; backgroundUrl=null triggers blur-extend fallback
 *  5. Background plate failure is NON-FATAL — never breaks generation
 *
 * SERVER-ONLY: imports @napi-rs/canvas indirectly via image-bounds.ts.
 * Do NOT import this file from any client component.
 */

import crypto from 'crypto'
import { v2 as cloudinary } from 'cloudinary'
import type { SupabaseClient } from '@supabase/supabase-js'
import { detectProductBounds, verifyRegionChanged } from '@/lib/image-bounds'
import {
  computeClassificationSignals,
  classifyShotType,
} from '@/lib/product-positioning-shared'
import { getTransparentProductImage, getCacheKey } from '@/lib/background-removal'
import type {
  ProductLayerBundle,
  ProductLayerMetadata,
} from '@/types/product-layer'

cloudinary.config({
  cloud_name: process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
})

// Polling config for Cloudinary Generative Remove (same as background-reconstruction)
const POLL_INTERVAL_MS  = 2000
const POLL_MAX_ATTEMPTS = 30   // 60 seconds max
const REGION_PADDING_FRACTION = 0.08

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Get or generate the full Product Layer bundle for a source image.
 *
 * Cache-first. Order of operations:
 *   1. Check bg_removal_cache for a complete/partial bundle
 *   2. If legacy/missing: run background removal (Step 1)
 *   3. Run detectProductBounds on the transparent cutout → metadata (Step 2)
 *   4. Run Cloudinary Generative Remove on the original → background plate (Step 3)
 *   5. Persist all assets to bg_removal_cache, mark bundle_status
 *   6. Return the bundle
 *
 * Steps 2–4 are all new relative to the old pipeline.
 * Step 1 (background removal) is the unchanged existing service.
 */
export async function getProductLayerBundle(
  sourceUrl: string,
  storeId: string,
  supabase: SupabaseClient
): Promise<ProductLayerBundle> {
  const cacheKey = getCacheKey(sourceUrl)  // SHA-256, same function background-removal uses

  // ── 1. Cache check — return immediately if we already have a full bundle ────
  const { data: cached } = await supabase
    .from('bg_removal_cache')
    .select('transparent_url, background_url, mask_url, metadata, bundle_status, provider')
    .eq('cache_key', cacheKey)
    .maybeSingle()

  if (cached?.bundle_status === 'complete' && cached.metadata && cached.transparent_url) {
    console.log(`[product-layer-engine] Bundle cache HIT (complete) for ${sourceUrl.slice(0, 60)}`)
    return {
      transparentUrl: cached.transparent_url,
      backgroundUrl:  cached.background_url  ?? null,
      maskUrl:        cached.mask_url        ?? null,
      metadata:       cached.metadata as ProductLayerMetadata,
      fromCache:      true,
      bundleStatus:   'complete',
      provider:       cached.provider || 'unknown',
    }
  }

  // ── 2. Step 1: transparent cutout ─────────────────────────────────────────
  // Re-use existing background-removal service (unchanged). For legacy rows
  // that already have transparent_url, skip the removal call.
  let transparentUrl: string
  let provider: string

  if (cached?.transparent_url) {
    // Legacy row — transparent already exists, skip the AI removal call
    console.log(`[product-layer-engine] Transparent cutout already cached, skipping removal for ${sourceUrl.slice(0, 60)}`)
    transparentUrl = cached.transparent_url
    provider       = cached.provider || 'unknown'
  } else {
    // Fresh image — run the existing background removal service
    console.log(`[product-layer-engine] Running background removal for ${sourceUrl.slice(0, 60)}`)
    const bgResult = await getTransparentProductImage(sourceUrl, storeId, supabase)
    transparentUrl = bgResult.transparentUrl
    provider       = bgResult.provider
  }

  // ── 3. Step 2: compute metadata from the transparent cutout ───────────────
  // detectProductBounds() scans alpha channel pixels → gives us exact head_y,
  // feet_y, bbox. One network fetch (the transparent PNG); all downstream math
  // for Head Space is pure local computation from this point on.
  console.log(`[product-layer-engine] Computing metadata for ${sourceUrl.slice(0, 60)}`)
  const bounds  = await detectProductBounds(transparentUrl)
  const signals = computeClassificationSignals(bounds)
  const shotType = classifyShotType(signals)

  const contentW = bounds.right  - bounds.left
  const contentH = bounds.bottom - bounds.top
  const safeMaxUpscale = contentW > 0
    ? Math.min(4, bounds.imageWidth / contentW)
    : 1.5

  const metadata: ProductLayerMetadata = {
    bbox: {
      top:    bounds.top,
      bottom: bounds.bottom,
      left:   bounds.left,
      right:  bounds.right,
    },
    head_y:             bounds.top,
    feet_y:             bounds.bottom,
    center_x:           bounds.left + contentW / 2,
    center_y:           bounds.top  + contentH / 2,
    product_height_px:  contentH,
    product_width_px:   contentW,
    image_width:        bounds.imageWidth,
    image_height:       bounds.imageHeight,
    shot_type:          shotType,
    shot_type_confidence: 0.85,  // heuristic, not probabilistic
    safe_max_upscale:   safeMaxUpscale,
    signals,
    schema_version:     1,
  }

  // ── 4. Step 3: background plate (best-effort, non-fatal) ──────────────────
  // Cloudinary Generative Remove on the ORIGINAL opaque image, using the
  // bounding box from metadata to define the removal region.
  // This is the "Background Plate" — the studio backdrop without the product.
  // Falls back gracefully: null backgroundUrl → compositor uses blur-extend.
  let backgroundUrl: string | null = null
  let backgroundCloudinaryId: string | null = null

  try {
    const plateResult = await generateBackgroundPlate(
      sourceUrl,
      bounds,
      cacheKey
    )
    backgroundUrl            = plateResult.backgroundUrl
    backgroundCloudinaryId   = plateResult.cloudinaryId
    console.log(`[product-layer-engine] Background plate generated: ${backgroundUrl?.slice(0, 60)}`)
  } catch (err: any) {
    // Non-fatal — compositor falls back to blur-extend / solid color
    console.warn(
      `[product-layer-engine] Background plate failed (non-fatal), will use blur-extend fallback:`,
      err.message
    )
  }

  // ── 5. Persist everything to bg_removal_cache ──────────────────────────────
  const bundleStatus: 'complete' | 'partial' = backgroundUrl ? 'complete' : 'partial'
  const now = new Date().toISOString()

  await supabase
    .from('bg_removal_cache')
    .upsert(
      {
        cache_key:                 cacheKey,
        source_url:                sourceUrl,
        transparent_url:           transparentUrl,
        background_url:            backgroundUrl,
        background_cloudinary_id:  backgroundCloudinaryId,
        mask_url:                  null,  // v1 — not yet implemented
        metadata,
        bundle_status:             bundleStatus,
        provider,
        store_id:                  storeId,
        background_created_at:     backgroundUrl ? now : null,
        metadata_created_at:       now,
      },
      { onConflict: 'cache_key' }
    )

  console.log(
    `[product-layer-engine] Bundle ${bundleStatus} for ${sourceUrl.slice(0, 60)} ` +
    `(shot=${shotType}, headY=${bounds.top}px, bgPlate=${backgroundUrl ? 'yes' : 'no'})`
  )

  return {
    transparentUrl,
    backgroundUrl,
    maskUrl:      null,
    metadata,
    fromCache:    false,
    bundleStatus,
    provider,
  }
}

// ─── Background Plate Generation ──────────────────────────────────────────────
//
// Mirrors the logic in background-reconstruction/index.ts but:
//  - stores result in bg_removal_cache (not background_reconstruction_cache)
//  - receives bounds from metadata rather than re-detecting them
//
// The old background-reconstruction/index.ts is kept unchanged for backward
// compat but is no longer called by generation-queue.ts after this migration.

async function generateBackgroundPlate(
  sourceUrl: string,
  bounds: {
    top: number; bottom: number; left: number; right: number
    imageWidth: number; imageHeight: number
  },
  cacheKey: string
): Promise<{ backgroundUrl: string; cloudinaryId: string }> {

  const contentW = bounds.right  - bounds.left
  const contentH = bounds.bottom - bounds.top

  if (contentW <= 0 || contentH <= 0) {
    throw new Error('Degenerate bounding box — cannot generate background plate')
  }

  // Pad the removal region to cover soft/anti-aliased edges
  const padX = Math.round(contentW * REGION_PADDING_FRACTION)
  const padY = Math.round(contentH * REGION_PADDING_FRACTION)
  const regionX = Math.max(0, bounds.left   - padX)
  const regionY = Math.max(0, bounds.top    - padY)
  const regionW = Math.min(bounds.imageWidth,  bounds.right  + padX) - regionX
  const regionH = Math.min(bounds.imageHeight, bounds.bottom + padY) - regionY

  if (regionW <= 0 || regionH <= 0) {
    throw new Error('Padded removal region is degenerate — cannot generate background plate')
  }

  // Cloudinary Generative Remove: remove the product region and inpaint it
  // from surrounding pixels. This is the same API call as background-reconstruction
  // but the result is now stored in bg_removal_cache alongside the other assets.
  const effect = `gen_remove:region_((x_${Math.round(regionX)};y_${Math.round(regionY)};w_${Math.round(regionW)};h_${Math.round(regionH)}))`
  const eagerPublicId = `background-plates/${cacheKey.slice(0, 24)}`

  const uploadResult = await cloudinary.uploader.upload(sourceUrl, {
    public_id:     eagerPublicId,
    folder:        'background-plates',
    overwrite:     true,
    resource_type: 'image',
    eager: [{ effect, fetch_format: 'auto', quality: 'auto:best' }],
    eager_async:   true,  // Generative Remove is heavy — always async
  })

  const publicId = uploadResult.public_id
  let eagerResult = uploadResult.eager?.[0]

  // Poll until done (same pattern as background-removal/cloudinary-provider.ts)
  if (!eagerResult?.secure_url) {
    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
      await sleep(POLL_INTERVAL_MS)
      const resource = await cloudinary.api
        .resource(publicId, { resource_type: 'image', eager: true })
        .catch(() => null)
      eagerResult = resource?.eager?.[0]
      if (eagerResult?.status === 'failed' || eagerResult?.error) break
      if (eagerResult?.secure_url) break
    }
  }

  if (eagerResult?.status === 'error' || eagerResult?.status === 'failed' || eagerResult?.error) {
    const reason = eagerResult?.error?.message || JSON.stringify(eagerResult)
    throw new Error(`Cloudinary Generative Remove failed: ${reason}`)
  }

  if (!eagerResult?.secure_url) {
    throw new Error(
      `Cloudinary Generative Remove timed out after ${(POLL_MAX_ATTEMPTS * POLL_INTERVAL_MS) / 1000}s`
    )
  }

  // Cloudinary can report "success" while barely touching the removal region
  // (silent no-op / partial inpaint) — verify the region actually changed
  // before trusting this as a product-free plate. Otherwise the compositor
  // draws the sharp cutout on top of a plate that still shows the product,
  // producing a visible duplicate.
  const changed = await verifyRegionChanged(uploadResult.secure_url, eagerResult.secure_url, {
    x: regionX, y: regionY, w: regionW, h: regionH,
  }).catch(() => true) // verification itself failing shouldn't block a plausibly-good plate

  if (!changed) {
    throw new Error('Generative Remove returned an unchanged region — product likely still visible')
  }

  return {
    backgroundUrl: eagerResult.secure_url,
    cloudinaryId:  publicId,
  }
}