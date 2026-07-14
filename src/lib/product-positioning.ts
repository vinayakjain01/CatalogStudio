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
  calculatePlacementNoLetterbox,
  computeClassificationSignals,
  classifyShotType,
  CLASSIFICATION_THRESHOLDS,
  isDegenerateBounds,
  type ClassificationSignals,
  type HeadSpacePlacement,
  type PlacementResult,
  type ProductBounds,
} from '@/lib/product-positioning-shared'
import { detectProductBounds, detectZoomSubjectBounds } from '@/lib/image-bounds'

export {
  placementToProductLayerSettings, calculatePlacement, calculatePlacementNoLetterbox,
  computeClassificationSignals, classifyShotType, CLASSIFICATION_THRESHOLDS,
  type ClassificationSignals,
  type HeadSpacePlacement, type PlacementResult,
  type ProductBounds, detectProductBounds, detectZoomSubjectBounds,
}

// Classification (CLASSIFICATION_THRESHOLDS / computeClassificationSignals /
// classifyShotType) and placement math (calculatePlacement / PlacementResult)
// all live in product-positioning-shared.ts — pure math with no
// @napi-rs/canvas dependency, so the live editor can classify + place
// instantly on every slider change from a once-fetched bounds object.
// Imported and re-exported above; this module adds only the server-side
// pieces (bounds detection via image-bounds.ts, and orchestration).

function isValidShotType(value: unknown): value is ShotType {
  return typeof value === 'string' && (SHOT_TYPES as string[]).includes(value)
}

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
  /**
   * True when bounds detection had nothing confident to report (bounds ==
   * the full image rect). Callers should still position the product — just
   * using calculatePlacementNoLetterbox() (full-image proxy, forced zoom)
   * instead of calculatePlacement() — rather than skipping positioning
   * altogether, which is what produced the "one product in the catalog is
   * letterboxed, its neighbors aren't" bug.
   */
  isDegenerate: boolean
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
  return {
    shotType, bounds, applies: settings.applyToShotTypes.includes(shotType), signals,
    isDegenerate: isDegenerateBounds(bounds),
  }
}

// ─── Product Zoom Mode's classification entry point ──────────────────────────
//
// Parallel to classifyProductImage() above (which is Standard Mode's and
// stays untouched) — same ClassifyResult contract, but backed by
// detectZoomSubjectBounds() (backdrop-contrast detection for opaque photos)
// instead of detectProductBounds() (alpha-channel only). See
// image-bounds.ts's detectZoomSubjectBounds for why opaque photos need a
// different detector.
//
// A low-confidence detection (isDegenerateBounds — "this is just the full
// image, not a real subject box") always sets applies:false, regardless of
// the shot-type guess or applyToShotTypes allow-list: forcing Head Space
// against bounds we don't trust would just reproduce the padding bug on that
// one photo, so Product Zoom bypasses to a plain contain-fit for it instead.

export async function classifyProductZoomImage(
  imageUrl: string,
  settings: Pick<ProductPositioningSettings, 'applyToShotTypes'>,
  manualShotTypeOverride?: ShotType | string | null
): Promise<ClassifyResult> {
  const bounds = await detectZoomSubjectBounds(imageUrl)
  const signals = computeClassificationSignals(bounds)
  const override = isValidShotType(manualShotTypeOverride) ? manualShotTypeOverride : null
  const shotType = override ?? classifyShotType(signals)
  const degenerate = isDegenerateBounds(bounds)
  // FIX: degenerate (low-confidence) detection used to force applies=false,
  // which silently skipped Head Space for that one photo and fell back to a
  // plain contain-fit — producing visible white letterboxing on exactly the
  // products whose backdrop was slightly harder to model, while every other
  // product in the same catalog filled the frame. The allow-list check is
  // still honoured (a flat-lay you've excluded stays excluded either way);
  // what no longer happens is disabling positioning JUST because detection
  // wasn't confident. The placement call site uses calculatePlacementNoLetterbox()
  // when isDegenerate is true, so the fallback still zooms to fill the guides
  // instead of leaving a gap.
  const applies = settings.applyToShotTypes.includes(shotType)
  return { shotType, bounds, applies, signals, isDegenerate: degenerate }
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