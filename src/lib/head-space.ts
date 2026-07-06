/**
 * Head Space — Intelligent Product Alignment
 *
 * Ensures every generated creative has the same visual top margin, regardless
 * of the original product image's shape or whitespace.
 *
 * Algorithm:
 *  1. Load the product image (transparent PNG preferred, JPEG supported).
 *  2. Scan pixels to find the bounding box of visible (non-transparent) content.
 *  3. Calculate the exact x, y, width, height to position the image so:
 *       - canvas_y_of_product_top  = headSpacePx
 *       - product is horizontally centered in the available area
 *       - scale is determined by fitting the visible content in the margins
 *  4. Return placement as a ProductLayerSettings override.
 *
 * This runs at the 1x canvas resolution.  The compositor's supersampling step
 * then scales everything up + back down for crispness.
 *
 * Performance:
 *  - Pixel scanning is done on a downscaled 800px-max analysis copy → ~1–3ms
 *  - The @napi-rs/canvas createCanvas / getImageData is server-only (worker)
 *  - Only runs when headSpaceSettings.enabled is true in the template
 */

import { createCanvas, loadImage } from '@napi-rs/canvas'
import type { ProductLayerSettings, DEFAULT_PRODUCT_LAYER_SETTINGS } from '@/types/template'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ProductBounds {
  left: number    // leftmost visible pixel x (in original image coords)
  top: number     // topmost visible pixel y
  right: number   // rightmost visible pixel x
  bottom: number  // bottommost visible pixel y
  imageWidth: number
  imageHeight: number
  hasTransparency: boolean
}

// ─── Pixel bounding box detection ─────────────────────────────────────────────

const ALPHA_THRESHOLD = 20    // pixels with alpha < this are considered empty
const MAX_ANALYSIS_DIM = 800  // downscale to this before scanning — keeps it fast

/**
 * Find the bounding box of non-transparent (or all, for opaque images) pixels.
 * Works on server-side only (uses @napi-rs/canvas).
 */
export async function detectProductBounds(imageUrl: string): Promise<ProductBounds> {
  const img = await loadImage(imageUrl)
  const imgW = img.width
  const imgH = img.height

  // Downscale for speed — we only need approximate bounds
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

  // Guard: if nothing found (fully transparent / empty), fall back to full image
  if (minX >= maxX || minY >= maxY) {
    return { left: 0, top: 0, right: imgW - 1, bottom: imgH - 1, imageWidth: imgW, imageHeight: imgH, hasTransparency: false }
  }

  // Convert back to original image coordinates
  return {
    left:   Math.max(0, Math.round(minX / scale)),
    top:    Math.max(0, Math.round(minY / scale)),
    right:  Math.min(imgW - 1, Math.round(maxX / scale)),
    bottom: Math.min(imgH - 1, Math.round(maxY / scale)),
    imageWidth: imgW,
    imageHeight: imgH,
    hasTransparency,
  }
}

// ─── Placement calculation ─────────────────────────────────────────────────────

export interface HeadSpacePlacement {
  /** Canvas x coordinate of the image's top-left corner (can be negative for bleed) */
  imgX: number
  /** Canvas y coordinate of the image's top-left corner (can be negative for bleed) */
  imgY: number
  /** Width to render the full image at */
  renderedW: number
  /** Height to render the full image at */
  renderedH: number
  /** Scale factor applied to the image */
  scale: number
}

export interface HeadSpaceConfig {
  headSpacePx: number
  leftMarginPx: number
  rightMarginPx: number
  bottomMarginPx: number
  autoCenterHorizontally: boolean
}

/**
 * Calculate where to draw the product image on the canvas so that:
 *  - The TOP of the visible product content is exactly headSpacePx from the canvas top.
 *  - The visible product is horizontally centered (if autoCenterHorizontally is true).
 *  - The product is never stretched or cropped — scale is maintained.
 *
 * Returns pixel coordinates in 1× canvas space.
 */
export function calculateHeadSpacePlacement(
  bounds: ProductBounds,
  canvasW: number,
  canvasH: number,
  config: HeadSpaceConfig
): HeadSpacePlacement {
  const { headSpacePx, leftMarginPx, rightMarginPx, bottomMarginPx, autoCenterHorizontally } = config

  const contentW = bounds.right  - bounds.left   // visible product width in original image px
  const contentH = bounds.bottom - bounds.top    // visible product height

  const availableW = canvasW - leftMarginPx - rightMarginPx
  const availableH = canvasH - headSpacePx - bottomMarginPx

  if (contentW <= 0 || contentH <= 0 || availableW <= 0 || availableH <= 0) {
    return { imgX: 0, imgY: 0, renderedW: canvasW, renderedH: canvasH, scale: canvasW / bounds.imageWidth }
  }

  const scaleToFitW = availableW / contentW    // scale so product fits width
  const scaleToFitH = availableH / contentH    // scale so product fits height

  let scale: number
  if (bounds.hasTransparency) {
    // ── Transparent product (after bg removal) ─────────────────────────────
    // Use CONTAIN: fit the visible product inside the available area.
    // We know exactly where the product starts/ends, so this gives perfect
    // "head at headSpacePx" alignment with no overflow or cropping.
    scale = Math.min(scaleToFitW, scaleToFitH)
  } else {
    // ── Opaque product photo (standard JPEG) ───────────────────────────────
    // Use FILL WIDTH: scale the image so it fills the available width.
    // The image top is placed at headSpacePx — for tall portrait photos the
    // feet may overflow below the canvas (they're cropped), which is the
    // correct visual behavior: every product fills the canvas with its top
    // at the same Y position, looking consistent across bulk generation.
    // We cap at 1.0 to avoid upscaling low-res images.
    scale = Math.min(scaleToFitW, 1.0)

    // If the product is very wide (landscape photo), scale down to fit height too
    // so we don't lose the head above the canvas top.
    const renderedHPreview = bounds.imageHeight * scale
    const imgYPreview = headSpacePx - bounds.top * scale
    if (imgYPreview < 0) {
      // Head would be above canvas — fall back to contain so head stays visible
      scale = Math.min(scaleToFitW, scaleToFitH)
    }
  }

  const renderedW = bounds.imageWidth  * scale
  const renderedH = bounds.imageHeight * scale

  // Vertical: top of visible content = headSpacePx
  const imgY = headSpacePx - bounds.top * scale

  // Horizontal: center visible content in available width
  let imgX: number
  if (autoCenterHorizontally) {
    const contentCenterOnCanvas = leftMarginPx + availableW / 2
    imgX = contentCenterOnCanvas - (bounds.left + contentW / 2) * scale
  } else {
    imgX = leftMarginPx - bounds.left * scale
  }

  return { imgX, imgY, renderedW, renderedH, scale }
}

/**
 * Convert a HeadSpacePlacement to ProductLayerSettings override.
 * This lets us slot the calculated placement into the existing
 * drawProductLayer pipeline without changing its API.
 *
 * @param placement  pixel-space placement (1× canvas)
 * @param canvasW    1× canvas width
 * @param canvasH    1× canvas height
 * @param base       existing settings to inherit effects (shadow, glow, etc.)
 */
export function placementToProductLayerSettings(
  placement: HeadSpacePlacement,
  canvasW: number,
  canvasH: number,
  base: typeof DEFAULT_PRODUCT_LAYER_SETTINGS
): typeof DEFAULT_PRODUCT_LAYER_SETTINGS {
  return {
    ...base,
    // Convert pixel coordinates to percentages
    x:      (placement.imgX     / canvasW) * 100,
    y:      (placement.imgY     / canvasH) * 100,
    width:  (placement.renderedW / canvasW) * 100,
    height: (placement.renderedH / canvasH) * 100,
    // 'fill' = draw at exactly the calculated dimensions — no extra scaling by drawProductLayer
    objectFit: 'fill',
    // No additional padding — margins are already baked in
    padding: 0,
  }
}