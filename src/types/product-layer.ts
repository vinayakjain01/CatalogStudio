/**
 * Product Layer Engine — Type Definitions
 *
 * FILE: src/types/product-layer.ts  (NEW FILE)
 *
 * Shared between:
 *  - src/lib/product-layer-engine.ts       (server — generates assets)
 *  - src/lib/generation-queue.ts           (server — passes bundle to compositor)
 *  - src/lib/compositor.ts                 (server — reads bundle at render time)
 *  - src/app/api/product-layer/bundle/     (API route — serialises to JSON)
 *  - src/components/builder/use-product-layer-bundle.ts  (client — deserialises)
 *  - src/components/builder/canvas-preview.tsx           (client — uses metadata)
 */

import type { ShotType } from '@/types/template'
import type { ClassificationSignals } from '@/lib/product-positioning-shared'

// ─── Stored geometry ──────────────────────────────────────────────────────────

/**
 * Axis-aligned bounding box of the visible product pixels.
 * All values are in original-image pixels.
 * Matches the shape returned by detectProductBounds() in image-bounds.ts.
 */
export interface ProductBoundingBox {
  top: number     // head pixel row (0 = image top)
  bottom: number  // feet/hem pixel row
  left: number
  right: number
}

/**
 * Persisted metadata about a product image's detected geometry.
 * Stored in bg_removal_cache.metadata (JSONB column).
 *
 * Computed once per unique source image, then reused for:
 *  - Every generation job (no detectProductBounds() call at job time)
 *  - Every Head Space slider move in the live editor (instant local math)
 *  - Safe-upscale enforcement in calculateSmartFitPlacement()
 */
export interface ProductLayerMetadata {
  /** Bounding box of visible product pixels in original-image pixel space */
  bbox: ProductBoundingBox

  // Derived convenience fields (duplicates of bbox for clarity in Head Space math)
  head_y: number          // == bbox.top  — the top of the product's visible content
  feet_y: number          // == bbox.bottom
  center_x: number        // horizontal center of bbox
  center_y: number        // vertical center of bbox

  product_height_px: number   // bbox.bottom - bbox.top
  product_width_px: number    // bbox.right  - bbox.left

  /** Dimensions of the source image from which the bbox was computed */
  image_width: number
  image_height: number

  /** Shot-type classification result (same enum as ProductPositioningSettings.applyToShotTypes) */
  shot_type: ShotType
  /** Confidence is always 0.85 — we use a deterministic heuristic, not a probabilistic model */
  shot_type_confidence: number

  /**
   * Maximum safe upscale factor: image_width / product_width_px, capped at 4.
   * Ensures Smart Fit never renders source pixels at >100% native size
   * beyond this limit — prevents blurry close-ups in bulk generation.
   */
  safe_max_upscale: number

  /** Raw signals that drove the shot_type decision — stored for debugging */
  signals: ClassificationSignals

  /** Schema version — bump if the shape changes, so backfill workers can re-process */
  schema_version: number  // currently 1
}

// ─── Runtime bundle ────────────────────────────────────────────────────────────

/**
 * The full asset bundle produced by getProductLayerBundle() in
 * src/lib/product-layer-engine.ts.
 *
 * Passed from generation-queue.ts → compositor.ts as options.productLayerBundle.
 * Also returned from the /api/product-layer/bundle API route to the live editor.
 *
 * Bundle status:
 *  'complete' = all assets present (transparentUrl + backgroundUrl + metadata)
 *  'partial'  = transparentUrl + metadata present; backgroundUrl failed
 *               Compositor falls back to blur-extend/solid for the background.
 */
export interface ProductLayerBundle {
  /** Transparent PNG cutout of the product — always present after processing */
  transparentUrl: string

  /**
   * The original studio backdrop with the product region AI-inpainted (Cloudinary
   * Generative Remove). null when the background plate generation failed.
   * When null, the compositor uses the existing blur-extend / solid fallback.
   */
  backgroundUrl: string | null

  /** Segmentation mask — stored for future use, null in v1 */
  maskUrl: string | null

  /** Geometry and classification data computed from the transparent cutout */
  metadata: ProductLayerMetadata

  fromCache: boolean
  bundleStatus: 'complete' | 'partial'
  provider: string
}

/**
 * Slimmed-down view passed into CompositeOptions.productLayerBundle.
 * Contains only what the compositor actually reads — keeps the API surface minimal.
 */
export interface CompositorBundle {
  transparentUrl: string
  backgroundUrl: string | null
  metadata: ProductLayerMetadata
}