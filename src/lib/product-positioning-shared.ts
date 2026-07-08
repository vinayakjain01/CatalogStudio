/**
 * Client-safe pieces of Product Positioning ("Head Space" v2).
 *
 * src/lib/product-positioning.ts imports @napi-rs/canvas (a native Node
 * addon) for bounds detection, so it can never be imported from client
 * components (e.g. the live editor's canvas preview). This file holds the
 * pure-math pieces that both the server module and client components need,
 * with zero server-only dependencies.
 */

import type { ProductLayerSettings, ProductPositioningSettings } from '@/types/template'

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

/**
 * Compute where to draw a product image so its visible content's top lands at
 * headSpacePx, the full image never crops, and it's never stretched. Ported
 * from the old (deleted) head-space.ts — that 4-constraint scale formula was
 * never the source of the crop bugs; only the "apply unconditionally" policy
 * around it was. See src/lib/product-positioning.ts for the fix (classification).
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
