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

import { createCanvas, loadImage } from '@napi-rs/canvas'
import type { ProductPositioningSettings, ShotType } from '@/types/template'
import { SHOT_TYPES } from '@/types/template'
import {
  placementToProductLayerSettings,
  type HeadSpacePlacement,
} from '@/lib/product-positioning-shared'

export { placementToProductLayerSettings, type HeadSpacePlacement }

// ─── URL normalization ────────────────────────────────────────────────────────

/**
 * Strip Shopify/Cloudinary/etc resize params so bounds-detection loads the same
 * pixel dimensions the compositor's toHighQualityUrl() will draw — otherwise the
 * scale calculated here won't match the image actually rendered.
 */
function stripResizeParams(src: string): string {
  if (!src) return src
  try {
    let r = src.replace(/_([\d]+)x([\d]+)?(@[\d]x)?(\.(?:jpg|jpeg|png|webp|gif))(\?.*)?$/i, '$4$5')
    r = r.replace(/\/upload\/([^/]+)\/(?=v\d+\/)/, (m, t) => (/^v\d+$/.test(t) ? m : '/upload/'))
    return r
  } catch {
    return src
  }
}

// ─── Bounds detection ─────────────────────────────────────────────────────────

export interface ProductBounds {
  left: number
  top: number
  right: number
  bottom: number
  imageWidth: number
  imageHeight: number
  hasTransparency: boolean
}

const ALPHA_THRESHOLD = 20
const MAX_ANALYSIS_DIM = 800

/**
 * Find the axis-aligned bounding box of visible (non-transparent) pixels.
 *
 * For transparent PNGs (post background-removal): detects the actual product
 * silhouette — bounds.top is the head pixel, bounds.bottom is feet/hem.
 *
 * For opaque JPEGs (no bg removal): hasTransparency=false, bounds = the full
 * image rectangle — there's no silhouette data to work with.
 */
export async function detectProductBounds(imageUrl: string): Promise<ProductBounds> {
  const normalizedUrl = stripResizeParams(imageUrl)
  const img = await loadImage(normalizedUrl).catch(() => loadImage(imageUrl))
  const imgW = img.width
  const imgH = img.height

  const scale = Math.min(1, MAX_ANALYSIS_DIM / Math.max(imgW, imgH))
  const analysisW = Math.max(1, Math.round(imgW * scale))
  const analysisH = Math.max(1, Math.round(imgH * scale))

  const tempCanvas = createCanvas(analysisW, analysisH)
  const ctx = tempCanvas.getContext('2d')
  ctx.drawImage(img as any, 0, 0, analysisW, analysisH)

  const imageData = ctx.getImageData(0, 0, analysisW, analysisH)
  const data = imageData.data

  let minX = analysisW
  let minY = analysisH
  let maxX = 0
  let maxY = 0
  let hasTransparency = false

  for (let y = 0; y < analysisH; y++) {
    for (let x = 0; x < analysisW; x++) {
      const alpha = data[(y * analysisW + x) * 4 + 3]
      if (alpha < 250) hasTransparency = true
      if (alpha > ALPHA_THRESHOLD) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }

  if (minX >= maxX || minY >= maxY) {
    return {
      left: 0, top: 0,
      right: imgW - 1, bottom: imgH - 1,
      imageWidth: imgW, imageHeight: imgH,
      hasTransparency: false,
    }
  }

  return {
    left:   Math.max(0,        Math.round(minX / scale)),
    top:    Math.max(0,        Math.round(minY / scale)),
    right:  Math.min(imgW - 1, Math.round(maxX / scale)),
    bottom: Math.min(imgH - 1, Math.round(maxY / scale)),
    imageWidth:  imgW,
    imageHeight: imgH,
    hasTransparency,
  }
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
  /** Edge-to-edge vertical span + narrow width → 'detail'. */
  detailMinAspectRatio: 1.6,
  /** Very tall/narrow silhouette → 'close_up'. */
  closeUpMinAspectRatio: 2.2,
  /** full_body band. */
  fullBodyMinAspectRatio: 1.35,
  fullBodyMinCoverage: 0.25,
  fullBodyMaxCoverage: 0.85,
  /** half_body band. */
  halfBodyMinAspectRatio: 0.9,
  halfBodyMaxAspectRatio: 1.35,
  halfBodyMinCoverage: 0.2,
  /** Above this coverage ratio (and not already 'detail') → 'flat_lay'. */
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
    signals.aspectRatio >= t.detailMinAspectRatio
  ) {
    return 'detail'
  }

  if (signals.aspectRatio >= t.closeUpMinAspectRatio) return 'close_up'

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

// ─── No-crop placement ─────────────────────────────────────────────────────────
//
// Ported from the old head-space.ts (that math was never the bug) with one
// addition: a max-upscale clamp so a tightly-cropped image manually
// overridden into full_body/half_body can't be zoomed in past readable
// quality. Reducing scale below the raw no-crop scale can only ever shrink
// the rendered box further inside the already-safe bounds, so it cannot
// introduce new overflow.

export interface PlacementResult {
  placement: HeadSpacePlacement
  wouldCrop: boolean
  clampedByMaxUpscale: boolean
}

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

  let rawScale: number
  if (scaleMode === 'smart_fit') {
    // Move first, scale only if required to hit the head-space target while
    // keeping the FULL image (not just the visible silhouette) inside canvas.
    const constraints: number[] = [
      availableW / contentW,                                   // visible width fits
      availableH / contentH,                                   // visible height fits
      availableH / (bounds.imageHeight - bounds.top),          // full image bottom fits
    ]
    if (bounds.top > 0) constraints.push(headSpacePx / bounds.top)   // full image top fits
    const valid = constraints.filter(s => isFinite(s) && s > 0)
    rawScale = valid.length > 0 ? Math.min(...valid) : containScale
  } else {
    // 'fit' — plain contain, still subject to the same full-image safety
    // constraints so it can never push the image off-canvas.
    const safe: number[] = [containScale, availableH / (bounds.imageHeight - bounds.top)]
    if (bounds.top > 0) safe.push(headSpacePx / bounds.top)
    rawScale = Math.min(...safe.filter(s => isFinite(s) && s > 0))
  }

  const maxAllowedScale = containScale * maxUpscale
  const scale = Math.min(rawScale, maxAllowedScale)
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

  // Final defensive clamp — floating point can push us fractions of a pixel
  // outside; this guarantees the full image never starts left/above canvas
  // origin or ends right/below the canvas edge.
  const clampedImgX = Math.max(0, Math.min(imgX, canvasW - renderedW))
  const clampedImgY = Math.max(0, Math.min(imgY, canvasH - renderedH))

  const overflowLeft   = Math.max(0, -clampedImgX)
  const overflowTop    = Math.max(0, -clampedImgY)
  const overflowRight  = Math.max(0, clampedImgX + renderedW - canvasW)
  const overflowBottom = Math.max(0, clampedImgY + renderedH - canvasH)
  const wouldCrop = overflowLeft > 0.5 || overflowTop > 0.5 || overflowRight > 0.5 || overflowBottom > 0.5

  return {
    placement: { imgX: clampedImgX, imgY: clampedImgY, renderedW, renderedH, scale },
    wouldCrop,
    clampedByMaxUpscale,
  }
}

/**
 * Standard-mode target box for the EXISTING ai_extend pipeline (Cloudinary
 * generative fill). Treats the layer's own box as the "canvas" for placement
 * purposes (standard-mode product layers are typically full-bleed). Returns
 * null when no extend is warranted — either the native image aspect ratio
 * already satisfies the placement within needsExtend's 1% tolerance (the
 * common case, stays network-free), or the placement would crop (the hard
 * backstop — bypass rather than force a bad extend).
 */
export function computeStandardModeTargetBox(
  bounds: ProductBounds,
  layerBoxW: number,
  layerBoxH: number,
  settings: ProductPositioningSettings
): { targetW: number; targetH: number } | null {
  const { placement, wouldCrop } = calculatePlacement(bounds, layerBoxW, layerBoxH, settings)
  if (wouldCrop) return null

  const targetW = Math.round(placement.renderedW)
  const targetH = Math.round(placement.renderedH)

  const nativeRatio = bounds.imageWidth / bounds.imageHeight
  const targetRatio = targetW / targetH
  const ratioDiff = Math.abs(nativeRatio - targetRatio) / nativeRatio

  // Matches needsExtend()'s own 1% tolerance (src/lib/image-extend/index.ts) —
  // keep these in sync so "no extend needed" means the same thing in both places.
  if (ratioDiff <= 0.01) return null

  return { targetW, targetH }
}

// ─── Classification step — shared by both template modes ─────────────────────
//
// ai_product mode needs a single canvas-sized placement (the product layer's
// settings ARE the placement). standard mode needs the classification/allow-list
// decision made independently of any specific layer box, since the actual
// placement math there runs per-layer against that layer's own box (see
// computeStandardModeTargetBox above). This step is shared between both.

export interface ClassifyResult {
  shotType: ShotType
  bounds: ProductBounds
  applies: boolean
}

export async function classifyProductImage(
  imageUrl: string,
  settings: Pick<ProductPositioningSettings, 'applyToShotTypes'>,
  manualShotTypeOverride?: ShotType | string | null
): Promise<ClassifyResult> {
  const bounds = await detectProductBounds(imageUrl)
  const override = isValidShotType(manualShotTypeOverride) ? manualShotTypeOverride : null
  const shotType = override ?? classifyShotType(computeClassificationSignals(bounds))
  return { shotType, bounds, applies: settings.applyToShotTypes.includes(shotType) }
}

// ─── Orchestration — ai_product mode's single entry point ────────────────────

export interface ResolvePositioningResult {
  apply: boolean
  shotType: ShotType | null
  placement: HeadSpacePlacement | null
  wouldCrop: boolean
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
    return { apply: false, shotType: classified.shotType, placement: null, wouldCrop: false }
  }

  const { placement, wouldCrop } = calculatePlacement(classified.bounds, canvasW, canvasH, settings)

  if (wouldCrop) {
    console.warn(`[product-positioning] placement would crop (shotType=${classified.shotType}) — bypassing to default rendering`)
    return { apply: false, shotType: classified.shotType, placement: null, wouldCrop: true }
  }

  return { apply: true, shotType: classified.shotType, placement, wouldCrop: false }
}
