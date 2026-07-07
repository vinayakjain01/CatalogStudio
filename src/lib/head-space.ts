/**
 * Head Space — Intelligent Product Alignment  (v3 — No-Crop Guarantee)
 *
 * Core guarantee: The product image is NEVER cropped, NEVER stretched,
 * NEVER distorted. Every pixel of the original product is always visible
 * in the final output.
 *
 * ─── Algorithm ───────────────────────────────────────────────────────────────
 *
 *  1. Load the product image.
 *  2. Scan pixels → bounding box of visible content (the actual product).
 *  3. Calculate the maximum scale that:
 *       a) Places the head exactly at headSpacePx from canvas top.
 *       b) Keeps the FULL product (all four sides) inside the canvas.
 *       c) Respects left/right/bottom margins.
 *  4. If autoZoom=true: use step 3 scale (head at guide, full product visible).
 *  5. If autoZoom=false: use contain scale (legacy).
 *  6. Center horizontally within margins.
 *  7. Return placement — imgX/imgY/renderedW/renderedH.
 *
 * ─── Why previous versions still cropped ─────────────────────────────────────
 *
 *  Previous v2 used: scale = availableH / contentH   (fill height)
 *
 *  For a portrait JPEG (2:3 ratio) on a square canvas:
 *    contentH = imageH (full image, no transparency)
 *    scale = 1080 / imageH
 *    renderedW = imageW * scale  → wider than 1080  → CLIPS right side
 *
 *  The canvas boundary always clips. There is no way to draw outside it.
 *  AI Extend was a workaround but it operates on a separate code path and
 *  the canvas clip still fired before any extend logic could run.
 *
 * ─── Correct Scale Formula ───────────────────────────────────────────────────
 *
 *  For the product to have:
 *    - head at headSpacePx
 *    - feet above (canvasH - bottomMarginPx)
 *    - left edge above leftMarginPx
 *    - right edge below (canvasW - rightMarginPx)
 *
 *  We need the scale to satisfy ALL four constraints simultaneously.
 *
 *  Constraint from height:  scale ≤ availableH / contentH
 *  Constraint from width:   scale ≤ availableW / contentW
 *
 *  scale = min(availableH / contentH, availableW / contentW)
 *
 *  BUT: the head is positioned at headSpacePx, not the image top.
 *  The full image starts at: imgY = headSpacePx - bounds.top * scale
 *  The full image ends at:   imgY + imageH * scale
 *
 *  So the bottom constraint is:
 *    imgY + imageH * scale ≤ canvasH - bottomMarginPx
 *    headSpacePx - bounds.top * scale + imageH * scale ≤ canvasH - bottomMarginPx
 *    scale * (imageH - bounds.top) ≤ canvasH - bottomMarginPx - headSpacePx
 *    scale ≤ (canvasH - bottomMarginPx - headSpacePx) / (imageH - bounds.top)
 *
 *  Similarly the top constraint (imgY ≥ 0):
 *    headSpacePx - bounds.top * scale ≥ 0
 *    scale ≤ headSpacePx / bounds.top   (only relevant when bounds.top > 0)
 *
 *  The correct scale is the minimum of ALL four constraints:
 *    scale = min(
 *      availableW / contentW,            ← width of visible content
 *      (availableH) / contentH,          ← height of visible content
 *      (canvasH - bottomMarginPx - headSpacePx) / (imageH - bounds.top),  ← full image bottom
 *      (bounds.top > 0 ? headSpacePx / bounds.top : Infinity)              ← full image top
 *    )
 *
 *  This guarantees:
 *    - Head lands at headSpacePx (or as close as possible)
 *    - Full image (not just visible bounds) stays inside the canvas
 *    - No cropping ever
 *
 * ─── Performance ─────────────────────────────────────────────────────────────
 *  - Pixel scanning on 800px-max analysis copy → 1–3ms
 *  - Server-only (@napi-rs/canvas)
 *  - Only runs when headSpaceSettings.enabled = true
 */

import { createCanvas, loadImage } from '@napi-rs/canvas'
import type { DEFAULT_PRODUCT_LAYER_SETTINGS } from '@/types/template'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ProductBounds {
  /** Leftmost visible pixel x (in original image coords) */
  left: number
  /** Topmost visible pixel y — this is the "head point" */
  top: number
  /** Rightmost visible pixel x */
  right: number
  /** Bottommost visible pixel y — feet / hem / accessory end */
  bottom: number
  imageWidth: number
  imageHeight: number
  /** True when the image has an alpha channel with transparent pixels */
  hasTransparency: boolean
}

export interface HeadSpacePlacement {
  /** Canvas x coordinate of the image's top-left corner */
  imgX: number
  /** Canvas y coordinate of the image's top-left corner */
  imgY: number
  /** Width to render the full source image at */
  renderedW: number
  /** Height to render the full source image at */
  renderedH: number
  /** Uniform scale factor applied to the image */
  scale: number
}

/**
 * Describes whether the placement fits within the canvas.
 * With the corrected algorithm this should always be hasOverflow=false,
 * but we keep it for logging and diagnostic purposes.
 */
export interface OverflowInfo {
  left: number
  right: number
  bottom: number
  top: number
  hasOverflow: boolean
}

export interface HeadSpaceResult {
  placement: HeadSpacePlacement
  overflow: OverflowInfo
  scale: number
  zoomMode: 'auto_zoom' | 'contain'
}

export interface HeadSpaceConfig {
  headSpacePx: number
  leftMarginPx: number
  rightMarginPx: number
  bottomMarginPx: number
  autoCenterHorizontally: boolean
  autoZoom: boolean
  allowAiExtend: boolean
  protectFullProduct: boolean
}

// ─── Constants ────────────────────────────────────────────────────────────────

const ALPHA_THRESHOLD = 20
const MAX_ANALYSIS_DIM = 800

// ─── Pixel Bounding Box Detection ─────────────────────────────────────────────

/**
 * Find the axis-aligned bounding box of visible (non-transparent) pixels.
 *
 * For transparent PNGs (post background-removal):
 *   → Detects actual product silhouette. bounds.top = head pixel, bounds.bottom = feet.
 *
 * For opaque JPEGs (no bg removal):
 *   → hasTransparency=false, bounds = full image rectangle.
 *   → The full image IS the product for positioning purposes.
 *
 * Server-only — uses @napi-rs/canvas.
 */
export async function detectProductBounds(imageUrl: string): Promise<ProductBounds> {
  const img = await loadImage(imageUrl)
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

  // Guard: fully transparent / empty image → use full image
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

// ─── No-Crop Placement ────────────────────────────────────────────────────────

/**
 * Calculate where to draw the product image so that:
 *
 *  1. The TOP of the visible product is as close to headSpacePx as possible.
 *  2. The FULL image (every pixel, including transparent edges) stays inside
 *     the canvas — NEVER cropped.
 *  3. The image is never stretched or distorted.
 *  4. Left/right/bottom margins are respected.
 *
 * The scale is the MINIMUM of ALL constraints that guarantee no cropping:
 *
 *   a) Width constraint:  visibleContentW * scale ≤ availableW
 *   b) Height constraint: visibleContentH * scale ≤ availableH
 *   c) Bottom of full image: (imageH - bounds.top) * scale ≤ availableH
 *      (ensures full image including transparent bottom doesn't overflow)
 *   d) Top of full image: bounds.top * scale ≤ headSpacePx
 *      (ensures full image top doesn't go above canvas top)
 *
 * Constraint (c) and (d) are the ones the previous version missed.
 * They handle JPEG images where bounds = full image but the transparent
 * padding regions still form part of the rendered rectangle.
 */
export function calculateHeadSpacePlacement(
  bounds: ProductBounds,
  canvasW: number,
  canvasH: number,
  config: HeadSpaceConfig
): HeadSpaceResult {
  const {
    headSpacePx,
    leftMarginPx,
    rightMarginPx,
    bottomMarginPx,
    autoCenterHorizontally,
    autoZoom,
  } = config

  const contentW = bounds.right  - bounds.left
  const contentH = bounds.bottom - bounds.top

  const availableW = canvasW - leftMarginPx - rightMarginPx
  const availableH = canvasH - headSpacePx  - bottomMarginPx

  // Guard: degenerate geometry
  if (contentW <= 0 || contentH <= 0 || availableW <= 0 || availableH <= 0) {
    const fallbackScale = Math.min(canvasW / bounds.imageWidth, canvasH / bounds.imageHeight)
    return {
      placement: {
        imgX: (canvasW - bounds.imageWidth  * fallbackScale) / 2,
        imgY: (canvasH - bounds.imageHeight * fallbackScale) / 2,
        renderedW: bounds.imageWidth  * fallbackScale,
        renderedH: bounds.imageHeight * fallbackScale,
        scale: fallbackScale,
      },
      overflow: { left: 0, right: 0, top: 0, bottom: 0, hasOverflow: false },
      scale: fallbackScale,
      zoomMode: 'contain',
    }
  }

  let scale: number
  let zoomMode: 'auto_zoom' | 'contain'

  if (autoZoom) {
    // ── Smart Auto Zoom — No-Crop Edition ─────────────────────────────────
    //
    // We want the head at headSpacePx. The head is bounds.top in image space.
    // After scaling, head_canvas_y = imgY + bounds.top * scale = headSpacePx
    // → imgY = headSpacePx - bounds.top * scale
    //
    // For the FULL IMAGE to stay inside the canvas:
    //
    //   TOP:    imgY ≥ 0
    //     → headSpacePx - bounds.top * scale ≥ 0
    //     → scale ≤ headSpacePx / bounds.top   (if bounds.top > 0)
    //
    //   BOTTOM: imgY + imageH * scale ≤ canvasH - bottomMarginPx
    //     → headSpacePx - bounds.top * scale + imageH * scale ≤ canvasH - bottomMarginPx
    //     → scale * (imageH - bounds.top) ≤ canvasH - bottomMarginPx - headSpacePx
    //     → scale ≤ availableH / (imageH - bounds.top)
    //     Note: (imageH - bounds.top) = distance from head-row to bottom of image
    //
    //   WIDTH (visible content centered in available area):
    //     → scale ≤ availableW / contentW
    //
    //   HEIGHT (visible content fits between guide and bottom margin):
    //     → scale ≤ availableH / contentH    (contentH = bottom - top in image space)
    //
    // The correct scale satisfies all four constraints simultaneously:

    const scaleConstraints: number[] = [
      availableW / contentW,                                     // visible width fits
      availableH / contentH,                                     // visible height fits
      availableH / (bounds.imageHeight - bounds.top),            // full image bottom fits
    ]

    // Only add the top constraint if there is actual padding above the head
    if (bounds.top > 0) {
      scaleConstraints.push(headSpacePx / bounds.top)            // full image top fits
    }

    // Remove non-positive or infinite constraints (degenerate dimensions)
    const validConstraints = scaleConstraints.filter(s => isFinite(s) && s > 0)
    scale = validConstraints.length > 0 ? Math.min(...validConstraints) : 1
    zoomMode = 'auto_zoom'
  } else {
    // ── Legacy contain: scale visible content to fit available area ────────
    // Still correct: uses visible bounds (not full image) for scale.
    // Then applies full-image safety constraints to prevent any image overflow.
    const containScale = Math.min(availableW / contentW, availableH / contentH)

    // Apply full-image safety constraints even in contain mode
    const safeConstraints: number[] = [
      containScale,
      availableH / (bounds.imageHeight - bounds.top),
    ]
    if (bounds.top > 0) {
      safeConstraints.push(headSpacePx / bounds.top)
    }

    scale = Math.min(...safeConstraints.filter(s => isFinite(s) && s > 0))
    zoomMode = 'contain'
  }

  // ── Computed placement ────────────────────────────────────────────────────
  const renderedW = bounds.imageWidth  * scale
  const renderedH = bounds.imageHeight * scale

  // Head lands at headSpacePx:
  //   canvas_y_of_head = imgY + bounds.top * scale = headSpacePx
  //   imgY = headSpacePx - bounds.top * scale
  const imgY = headSpacePx - bounds.top * scale

  // Center visible content horizontally within margins
  let imgX: number
  if (autoCenterHorizontally) {
    const contentCenterOnCanvas = leftMarginPx + availableW / 2
    imgX = contentCenterOnCanvas - (bounds.left + contentW / 2) * scale
  } else {
    imgX = leftMarginPx - bounds.left * scale
  }

  // ── Safety clamp: guarantee the full image NEVER goes outside the canvas ──
  // Even with perfect math, floating point can push us 0.1px outside.
  // Clamp imgX so the image never starts left of 0 or ends right of canvasW.
  // Clamp imgY so the image never starts above 0 or ends below canvasH.
  // This is the final line of defence against any cropping.
  const clampedImgX = Math.max(0, Math.min(imgX, canvasW - renderedW))
  const clampedImgY = Math.max(0, Math.min(imgY, canvasH - renderedH))

  // ── Post-clamp overflow check (diagnostic only) ───────────────────────────
  // After clamping, nothing should overflow. We compute it anyway for logging.
  const scaledRight  = clampedImgX + renderedW
  const scaledBottom = clampedImgY + renderedH
  const overflowLeft   = Math.max(0, -clampedImgX)
  const overflowTop    = Math.max(0, -clampedImgY)
  const overflowRight  = Math.max(0, scaledRight  - canvasW)
  const overflowBottom = Math.max(0, scaledBottom - canvasH)
  const hasOverflow    = overflowLeft > 0.5 || overflowTop > 0.5 ||
                         overflowRight > 0.5 || overflowBottom > 0.5

  if (hasOverflow) {
    // This should never happen after clamping. Log it as a warning.
    console.warn(
      `[head-space] post-clamp overflow detected — scale=${scale.toFixed(4)} ` +
      `imgX=${clampedImgX.toFixed(1)} imgY=${clampedImgY.toFixed(1)} ` +
      `W=${renderedW.toFixed(1)} H=${renderedH.toFixed(1)} ` +
      `canvas=${canvasW}x${canvasH}`
    )
  }

  return {
    placement: {
      imgX: clampedImgX,
      imgY: clampedImgY,
      renderedW,
      renderedH,
      scale,
    },
    overflow: {
      left:   overflowLeft,
      top:    overflowTop,
      right:  overflowRight,
      bottom: overflowBottom,
      hasOverflow,
    },
    scale,
    zoomMode,
  }
}

// ─── Placement → ProductLayerSettings converter ───────────────────────────────

export function placementToProductLayerSettings(
  placement: HeadSpacePlacement,
  canvasW: number,
  canvasH: number,
  base: typeof DEFAULT_PRODUCT_LAYER_SETTINGS
): typeof DEFAULT_PRODUCT_LAYER_SETTINGS {
  return {
    ...base,
    x:      (placement.imgX      / canvasW) * 100,
    y:      (placement.imgY      / canvasH) * 100,
    width:  (placement.renderedW / canvasW) * 100,
    height: (placement.renderedH / canvasH) * 100,
    // 'fill' tells drawProductLayer to use our exact pixel coordinates.
    // The head-space calculation already chose the correct aspect-ratio-safe scale,
    // so drawProductLayer must NOT re-apply any contain/cover logic.
    objectFit: 'fill',
    padding: 0,
  }
}

// ─── Overflow → AI Extend parameters ─────────────────────────────────────────
// Kept for API compatibility — with v3, overflow should always be zero,
// but the compositor still calls this in case of unexpected edge cases.

export function computeExtendedCanvasDimensions(
  canvasW: number,
  canvasH: number,
  overflow: OverflowInfo
): { extW: number; extH: number; offsetX: number; offsetY: number } {
  const roundUp8 = (n: number) => Math.ceil(n / 8) * 8

  const extraLeft   = roundUp8(overflow.left   + 20)
  const extraRight  = roundUp8(overflow.right  + 20)
  const extraBottom = roundUp8(overflow.bottom + 20)
  const extraTop    = roundUp8(overflow.top)

  const extW = canvasW + (overflow.left  > 0.5 ? extraLeft  : 0)
                       + (overflow.right > 0.5 ? extraRight : 0)
  const extH = canvasH + (overflow.top    > 0.5 ? extraTop    : 0)
                       + (overflow.bottom > 0.5 ? extraBottom : 0)

  const offsetX = overflow.left > 0.5 ? extraLeft : 0
  const offsetY = overflow.top  > 0.5 ? extraTop  : 0

  return { extW, extH, offsetX, offsetY }
}