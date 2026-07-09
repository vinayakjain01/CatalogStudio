/**
 * Client-safe pieces of Product Positioning ("Head Space" v2).
 *
 * src/lib/product-positioning.ts imports @napi-rs/canvas (a native Node
 * addon) for bounds detection, so it can never be imported from client
 * components (e.g. the live editor's canvas preview). This file holds the
 * pure-math pieces that both the server module and client components need,
 * with zero server-only dependencies.
 */

import type { ProductLayerSettings, ProductPositioningSettings, ShotType } from '@/types/template'

export interface HeadSpacePlacement {
  imgX: number
  imgY: number
  renderedW: number
  renderedH: number
  scale: number
}

/** Convert a pixel-space placement into a ProductLayerSettings percentage override (ai_product mode). */
export function placementToProductLayerSettings(
  placement: HeadSpacePlacement,
  canvasW: number,
  canvasH: number,
  base: ProductLayerSettings
): ProductLayerSettings {
  return {
    ...base,
    x:      (placement.imgX      / canvasW) * 100,
    y:      (placement.imgY      / canvasH) * 100,
    width:  (placement.renderedW / canvasW) * 100,
    height: (placement.renderedH / canvasH) * 100,
    // 'fill' tells drawProductLayer to use these exact pixel coordinates —
    // the placement math already chose the correct aspect-ratio-safe scale,
    // so no further contain/cover logic should be re-applied.
    objectFit: 'fill',
    padding: 0,
  }
}

// ─── Bounds shape + no-crop placement math (pure — no @napi-rs/canvas) ───────
//
// ProductBounds is produced server-side by detectProductBounds() (needs
// @napi-rs/canvas), but the shape itself and everything downstream of it
// (calculatePlacement) is plain math, safe to share with client components
// that receive an already-computed ProductBounds/placement over the wire.

export interface ProductBounds {
  left: number
  top: number
  right: number
  bottom: number
  imageWidth: number
  imageHeight: number
  hasTransparency: boolean
}

export interface PlacementResult {
  placement: HeadSpacePlacement
  wouldCrop: boolean
  clampedByMaxUpscale: boolean
}

// ─── Shot-type classification (pure — no @napi-rs/canvas) ────────────────────
//
// Heuristic-only (no AI/ML call) — computed purely from a ProductBounds.
// Lives here (not in the server-only module) so the live editor can classify
// and re-place INSTANTLY on every slider change from a bounds object it
// fetched once per image — zero API calls while dragging. Thresholds are
// tunable; they encode the following reasoning about fashion catalog
// photography:
//
//  - full_body:  a standing figure — tall aspect ratio, moderate-to-large
//                coverage, with room at the sides for arms/stance.
//  - half_body:  waist-up/bust shot — less elongated than a standing figure
//                (width doesn't shrink the way legs do), still substantial
//                coverage.
//  - close_up:   tall/narrow AND fills most of the frame. Aspect ratio alone
//                is NOT a reliable close-up signal — a standing human figure
//                is naturally 3-4x taller than wide, so a genuine full-body
//                shot with generous margins is ALSO tall/narrow in shape.
//                What distinguishes "zoomed in tight" from "full body with
//                headroom" is COVERAGE.
//  - detail:     content spans the full vertical frame edge-to-edge but is
//                narrow — a macro/fabric-texture/zipper shot.
//  - accessory:  a small isolated object (jewelry/belt/bag) on a large mostly
//                empty transparent canvas.
//  - flat_lay:   a garment/object filling almost the entire frame, or the
//                safe default for anything that doesn't match above.
//
// Only 'full_body'/'half_body' land in the default applyToShotTypes allow-list.

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
  /** Tall/narrow AND fills most of the frame → 'close_up'. */
  closeUpMinAspectRatio: 2.6,
  closeUpMinCoverage: 0.45,
  /** full_body band — wide aspect-ratio allowance, capped coverage. */
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

/**
 * Compute where to draw a product image so its visible content is scaled to
 * fit BETWEEN two guides simultaneously — top at headSpacePx, bottom at
 * (canvasH - bottomMarginPx) — never stretched, never cropped.
 *
 * scale = min(availableW/contentW, availableH/contentH)   — fits both the
 * horizontal margins and the vertical head/bottom guides at once. Content
 * top then lands at exactly headSpacePx, and — by construction, since
 * availableH = canvasH - headSpacePx - bottomMarginPx — content bottom lands
 * at exactly (canvasH - bottomMarginPx) too, UNLESS width is the binding
 * constraint (an unusually wide stance/pose), in which case bottom won't
 * quite reach the guide but nothing crops horizontally either — "never crop"
 * wins over "always touch both guides" in that rare case.
 *
 * Deliberately uses only the DETECTED CONTENT's bounding box, not the full
 * source image dimensions: for a transparent PNG (ai_product mode), any
 * margin between the image's own edges and the visible silhouette is
 * invisible padding — letting it fall outside the canvas is harmless and
 * was, in an earlier version of this formula, the reason the bottom guide
 * was never reached (an extra "protect full image" constraint was
 * needlessly conservative). For an opaque photo (standard mode, no
 * transparency), bounds already equal the full image rect, so this reduces
 * to the same thing either way.
 */
export function calculatePlacement(
  bounds: ProductBounds,
  canvasW: number,
  canvasH: number,
  settings: Pick<ProductPositioningSettings,
    'headSpacePx' | 'leftMarginPx' | 'rightMarginPx' | 'bottomMarginPx' |
    'autoCenterHorizontally' | 'scaleMode' | 'maxUpscale'>
): PlacementResult {
  const { headSpacePx, leftMarginPx, rightMarginPx, bottomMarginPx, autoCenterHorizontally, scaleMode, maxUpscale } = settings

  const contentW = bounds.right - bounds.left
  const contentH = bounds.bottom - bounds.top

  const availableW = canvasW - leftMarginPx - rightMarginPx
  const availableH = canvasH - headSpacePx - bottomMarginPx

  // Degenerate geometry (e.g. margins configured larger than the canvas) —
  // fall back to a basic contain-to-canvas fit. Never crops; just ignores
  // head-space/margins for this one pathological configuration.
  if (contentW <= 0 || contentH <= 0 || availableW <= 0 || availableH <= 0) {
    const fallbackScale = Math.min(canvasW / bounds.imageWidth, canvasH / bounds.imageHeight)
    return {
      placement: {
        imgX: (canvasW - bounds.imageWidth * fallbackScale) / 2,
        imgY: (canvasH - bounds.imageHeight * fallbackScale) / 2,
        renderedW: bounds.imageWidth * fallbackScale,
        renderedH: bounds.imageHeight * fallbackScale,
        scale: fallbackScale,
      },
      wouldCrop: false,
      clampedByMaxUpscale: false,
    }
  }

  const containScale = Math.min(availableW / contentW, availableH / contentH)

  // 'smart_fit': always zoom to hit both guides (up to maxUpscale). 'fit':
  // never enlarge past native pixel size — may leave a gap rather than
  // upscale, but never loses quality.
  const rawScale = scaleMode === 'smart_fit' ? containScale : Math.min(1, containScale)

  // maxUpscale is an ABSOLUTE cap on the scale factor (e.g. 1.5 = never
  // render source pixels at more than 150% of their native size) — not
  // relative to containScale, which would make it a no-op for smart_fit
  // (since containScale already IS the scale smart_fit wants to use).
  const scale = Math.min(rawScale, maxUpscale)
  const clampedByMaxUpscale = scale < rawScale - 1e-9

  const renderedW = bounds.imageWidth * scale
  const renderedH = bounds.imageHeight * scale
  const imgY = headSpacePx - bounds.top * scale

  let imgX: number
  if (autoCenterHorizontally) {
    const contentCenterOnCanvas = leftMarginPx + availableW / 2
    imgX = contentCenterOnCanvas - (bounds.left + contentW / 2) * scale
  } else {
    imgX = leftMarginPx - bounds.left * scale
  }

  // wouldCrop reflects the VISIBLE CONTENT only (never the full image,
  // whose margins may be transparent) — content is guaranteed to fit by
  // construction above, so this only fires for genuine floating-point edge
  // cases, and is the hard backstop the caller bypasses on rather than
  // shifting position (which would break the "touch both guides" guarantee).
  const contentTop    = imgY + bounds.top * scale
  const contentBottom = imgY + bounds.bottom * scale
  const contentLeft   = imgX + bounds.left * scale
  const contentRight  = imgX + bounds.right * scale
  const wouldCrop =
    contentTop < -0.5 || contentLeft < -0.5 ||
    contentBottom > canvasH + 0.5 || contentRight > canvasW + 0.5

  return {
    placement: { imgX, imgY, renderedW, renderedH, scale },
    wouldCrop,
    clampedByMaxUpscale,
  }
}
