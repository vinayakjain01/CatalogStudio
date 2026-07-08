/**
 * Product Positioning ("Head Space") — v2
 *
 * A near-identical feature was built and fully reverted on 2026-07-07 after
 * repeated "crop image error" bugs. Root cause: the old code applied
 * head-space repositioning UNCONDITIONALLY to every product image, including
 * flat-lays/close-ups/detail-shots/accessories where there is no coherent
 * "head" to align. For those shapes, forcing the bounding-box top to sit at
 * headSpacePx while also satisfying the width-fit constraint produced
 * geometrically infeasible placements.
 *
 * This version adds one thing the old one never had: shot-type
 * classification (§ classifyShotType) gates WHICH images this applies to.
 * Only 'full_body'/'half_body' get repositioned by default; everything else
 * renders exactly as it does today. The bounding-box detection and the
 * 4-constraint no-crop scale formula below are otherwise unchanged from the
 * old implementation — that math was never the source of the bug.
 *
 * Server-only (uses @napi-rs/canvas). Every entry point in this module is a
 * pure function of its inputs — no DB reads, no network calls beyond loading
 * the image itself.
 */

import type { ProductPositioningSettings, ShotType } from '@/types/template'
import { SHOT_TYPES } from '@/types/template'
import {
  placementToProductLayerSettings,
  calculatePlacement,
  type HeadSpacePlacement,
  type PlacementResult,
  type ProductBounds,
} from '@/lib/product-positioning-shared'
import { detectProductBounds } from '@/lib/image-bounds'

export {
  placementToProductLayerSettings, calculatePlacement,
  type HeadSpacePlacement, type PlacementResult,
  type ProductBounds, detectProductBounds,
}

// ─── Shot-type classification ─────────────────────────────────────────────────
//
// Heuristic-only (no AI/ML call) — computed purely from the bounding box above.
// Thresholds are tunable; they encode the following reasoning about fashion
// catalog photography:
//
//  - full_body:  a standing figure — tall aspect ratio, moderate-to-large
//                coverage, with room at the sides for arms/stance.
//  - half_body:  waist-up/bust shot — less elongated than a standing figure
//                (width doesn't shrink the way legs do), still substantial
//                coverage.
//  - close_up:   very tall/narrow silhouette relative to width — a tight
//                face/torso crop, not a garment on a person (a person has
//                shoulder/hip width; a close-up crop usually doesn't).
//  - detail:     content spans the full vertical frame edge-to-edge but is
//                narrow — a macro/fabric-texture/zipper shot where the camera
//                is right up against the subject.
//  - accessory:  a small isolated object (jewelry/belt/bag) on a large mostly
//                empty transparent canvas.
//  - flat_lay:   a garment/object filling almost the entire frame with no
//                surrounding space, or the safe default for anything that
//                doesn't match a more specific pattern above.
//
// Only 'full_body'/'half_body' land in the default applyToShotTypes allow-list
// (see DEFAULT_PRODUCT_POSITIONING_SETTINGS) — everything else bypasses
// head-space positioning and renders exactly as it does today.

export const CLASSIFICATION_THRESHOLDS = {
  /** Fraction of the shorter image side used as "touches the edge" tolerance. */
  edgeToleranceFraction: 0.01,
  minEdgeTolerancePx: 4,
  /** Below this coverage ratio → 'accessory'. */
  accessoryMaxCoverage: 0.12,
  /** Opaque (no-transparency) fallback: aspect ratio threshold for full_body vs flat_lay. */
  opaqueFullBodyAspectRatio: 1.15,
  /** Edge-to-edge vertical span + narrow width + high coverage → 'detail'. */
  detailMinAspectRatio: 1.6,
  detailMinCoverage: 0.4,
  /**
   * Tall/narrow AND fills most of the frame → 'close_up'.
   * Aspect ratio alone is NOT a reliable close-up signal — a standing human
   * figure is naturally 3-4x taller than wide, so a genuine full-body shot
   * with generous product-photography margins is ALSO tall/narrow in SHAPE.
   * What actually distinguishes "zoomed in tight" from "full body with
   * headroom" is COVERAGE: a close-up fills most of the frame; a full body
   * shot with margins occupies much less of it despite the same aspect ratio.
   * Both conditions must hold, or a real full-body photo gets misclassified
   * (this exact bug was observed: a full-body photo at aspect ratio ~2.3-2.5
   * with normal margins was wrongly caught by an aspect-ratio-only rule).
   */
  closeUpMinAspectRatio: 2.6,
  closeUpMinCoverage: 0.45,
  /** full_body band — deliberately wide aspect-ratio allowance (a standing
   *  figure can be very tall/narrow) but capped coverage (margins are typical). */
  fullBodyMinAspectRatio: 1.3,
  fullBodyMinCoverage: 0.12,
  fullBodyMaxCoverage: 0.85,
  /** half_body band. */
  halfBodyMinAspectRatio: 0.8,
  halfBodyMaxAspectRatio: 1.3,
  halfBodyMinCoverage: 0.2,
  /** Above this coverage ratio (and not already 'detail'/'close_up') → 'flat_lay'. */
  flatLayMinCoverage: 0.85,
} as const

export interface ClassificationSignals {
  coverageRatio: number
  aspectRatio: number
  touchesTopEdge: boolean
  touchesBottomEdge: boolean
  touchesLeftEdge: boolean
  touchesRightEdge: boolean
  hasTransparency: boolean
}

export function computeClassificationSignals(bounds: ProductBounds): ClassificationSignals {
  const contentW = Math.max(1, bounds.right - bounds.left)
  const contentH = Math.max(1, bounds.bottom - bounds.top)
  const coverageRatio = (contentW * contentH) / (bounds.imageWidth * bounds.imageHeight)
  const aspectRatio = contentH / contentW

  const edgeTolerancePx = Math.max(
    CLASSIFICATION_THRESHOLDS.minEdgeTolerancePx,
    Math.round(CLASSIFICATION_THRESHOLDS.edgeToleranceFraction * Math.min(bounds.imageWidth, bounds.imageHeight))
  )

  return {
    coverageRatio,
    aspectRatio,
    touchesTopEdge:    bounds.top    <= edgeTolerancePx,
    touchesBottomEdge: bounds.bottom >= bounds.imageHeight - 1 - edgeTolerancePx,
    touchesLeftEdge:   bounds.left   <= edgeTolerancePx,
    touchesRightEdge:  bounds.right  >= bounds.imageWidth  - 1 - edgeTolerancePx,
    hasTransparency:   bounds.hasTransparency,
  }
}

export function classifyShotType(signals: ClassificationSignals): ShotType {
  const t = CLASSIFICATION_THRESHOLDS

  // No silhouette data at all — riskiest branch, pure aspect-ratio guess.
  // The manual per-product override exists specifically to correct this branch.
  if (!signals.hasTransparency) {
    return signals.aspectRatio >= t.opaqueFullBodyAspectRatio ? 'full_body' : 'flat_lay'
  }

  if (signals.coverageRatio < t.accessoryMaxCoverage) return 'accessory'

  if (
    signals.touchesTopEdge && signals.touchesBottomEdge &&
    !signals.touchesLeftEdge && !signals.touchesRightEdge &&
    signals.aspectRatio >= t.detailMinAspectRatio &&
    signals.coverageRatio >= t.detailMinCoverage
  ) {
    return 'detail'
  }

  if (signals.aspectRatio >= t.closeUpMinAspectRatio && signals.coverageRatio >= t.closeUpMinCoverage) {
    return 'close_up'
  }

  if (
    signals.aspectRatio >= t.fullBodyMinAspectRatio &&
    signals.coverageRatio >= t.fullBodyMinCoverage &&
    signals.coverageRatio <= t.fullBodyMaxCoverage
  ) {
    return 'full_body'
  }

  if (
    signals.aspectRatio >= t.halfBodyMinAspectRatio &&
    signals.aspectRatio < t.halfBodyMaxAspectRatio &&
    signals.coverageRatio >= t.halfBodyMinCoverage
  ) {
    return 'half_body'
  }

  if (signals.coverageRatio > t.flatLayMinCoverage) return 'flat_lay'

  return 'flat_lay'
}

function isValidShotType(value: unknown): value is ShotType {
  return typeof value === 'string' && (SHOT_TYPES as string[]).includes(value)
}

// calculatePlacement / PlacementResult now live in product-positioning-shared.ts
// (pure math, no @napi-rs/canvas dependency — imported and re-exported above).

// ─── Classification step — shared by both template modes ─────────────────────
//
// ai_product mode needs a single canvas-sized placement (the product layer's
// settings ARE the placement). standard mode needs the classification/allow-list
// decision made independently of any specific layer box, since the actual
// placement math there runs per-layer against that layer's own box.

export interface ClassifyResult {
  shotType: ShotType
  bounds: ProductBounds
  applies: boolean
  signals: ClassificationSignals
}

export async function classifyProductImage(
  imageUrl: string,
  settings: Pick<ProductPositioningSettings, 'applyToShotTypes'>,
  manualShotTypeOverride?: ShotType | string | null
): Promise<ClassifyResult> {
  const bounds = await detectProductBounds(imageUrl)
  const signals = computeClassificationSignals(bounds)
  const override = isValidShotType(manualShotTypeOverride) ? manualShotTypeOverride : null
  const shotType = override ?? classifyShotType(signals)
  return { shotType, bounds, applies: settings.applyToShotTypes.includes(shotType), signals }
}

// ─── Orchestration — ai_product mode's single entry point ────────────────────

export interface ResolvePositioningResult {
  apply: boolean
  shotType: ShotType | null
  placement: HeadSpacePlacement | null
  wouldCrop: boolean
  /** Diagnostic only — raw signals behind the shotType decision. */
  signals?: ClassificationSignals
}

export async function resolveProductPositioning(
  imageUrl: string | null | undefined,
  canvasW: number,
  canvasH: number,
  settings: ProductPositioningSettings | undefined,
  manualShotTypeOverride?: ShotType | string | null
): Promise<ResolvePositioningResult> {
  // No-op guarantee: absent/disabled settings never load an image or run any
  // pixel scan. Existing templates render through exactly the same path they
  // do today.
  if (!settings || !settings.enabled || !imageUrl) {
    return { apply: false, shotType: null, placement: null, wouldCrop: false }
  }

  let classified: ClassifyResult
  try {
    classified = await classifyProductImage(imageUrl, settings, manualShotTypeOverride)
  } catch (err: any) {
    console.warn('[product-positioning] bounds detection failed, bypassing:', err?.message)
    return { apply: false, shotType: null, placement: null, wouldCrop: false }
  }

  if (!classified.applies) {
    return { apply: false, shotType: classified.shotType, placement: null, wouldCrop: false, signals: classified.signals }
  }

  const { placement, wouldCrop } = calculatePlacement(classified.bounds, canvasW, canvasH, settings)

  if (wouldCrop) {
    console.warn(`[product-positioning] placement would crop (shotType=${classified.shotType}) — bypassing to default rendering`)
    return { apply: false, shotType: classified.shotType, placement: null, wouldCrop: true, signals: classified.signals }
  }

  return { apply: true, shotType: classified.shotType, placement, wouldCrop: false, signals: classified.signals }
}
