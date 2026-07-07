/**
 * Head Space — Intelligent Product Alignment  (v2 — Smart Auto Zoom)
 *
 * Ensures every generated creative has identical head position, regardless
 * of model height, photo framing, camera distance, or aspect ratio.
 *
 * Like Zara. Like H&M. Like Myntra. Like Ajio.
 *
 * ─── Algorithm ───────────────────────────────────────────────────────────────
 *
 *  1. Load the product image (transparent PNG preferred, JPEG supported).
 *  2. Scan pixels → exact bounding box of visible (non-transparent) content.
 *  3. Find the "head point" = top-most visible pixel.
 *  4. Calculate ZOOM FACTOR so that head lands exactly at headSpacePx.
 *       scale = (canvasH - headSpacePx - bottomMarginPx) / contentH    ← fit height
 *       OR larger if autoZoom=true and head needs to move UP to guide line.
 *  5. Translate the image so head_y_in_canvas === headSpacePx exactly.
 *  6. Detect OVERFLOW: does any part of the scaled product extend below
 *     (canvasH - bottomMarginPx) or outside horizontal margins?
 *  7. Return OverflowInfo alongside placement so the compositor can decide
 *     whether to trigger AI Extend.
 *
 * ─── Why simple scaling FAILS ────────────────────────────────────────────────
 *
 *  Simple contain-scale uses:   scale = min(availW / contentW,  availH / contentH)
 *
 *  This makes tall models tiny and wide/cropped models huge.
 *  Head position varies because the scale is driven by the most constrained
 *  dimension — which changes for every image.
 *
 *  Smart Auto Zoom instead uses:
 *    scale = (canvasH - headSpacePx - bottomMarginPx) / contentH
 *
 *  This anchors scale to the HEIGHT of the visible product, so every model
 *  is rendered at the same physical height in the canvas, and the head
 *  always lands at exactly headSpacePx from the top.
 *
 *  If the zoomed product is wider than the available area, AI Extend fills
 *  the sides. If it overflows the bottom, AI Extend fills below.
 *  Neither crop nor stretch is ever used.
 *
 * ─── Performance ─────────────────────────────────────────────────────────────
 *  - Pixel scanning runs on an 800px-max analysis copy → 1–3 ms.
 *  - @napi-rs/canvas createCanvas / getImageData is server-only (worker).
 *  - Only runs when headSpaceSettings.enabled is true in the template.
 */

import { createCanvas, loadImage } from '@napi-rs/canvas'
import type { HeadSpaceSettings, DEFAULT_PRODUCT_LAYER_SETTINGS } from '@/types/template'

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
  /** Canvas x coordinate of the image's top-left corner (can be negative for bleed) */
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
 * When autoZoom causes the product to overflow the canvas boundary,
 * this describes how much extra canvas area is needed in each direction.
 * All values are in 1× canvas pixels. Zero means no overflow in that direction.
 */
export interface OverflowInfo {
  left: number    // pixels the product bleeds past the left edge (≥0)
  right: number   // pixels past the right edge
  bottom: number  // pixels past the bottom edge
  top: number     // pixels past the top edge (should always be 0 with headspace logic)
  /** True if ANY overflow detected — caller should trigger AI Extend */
  hasOverflow: boolean
}

export interface HeadSpaceResult {
  placement: HeadSpacePlacement
  overflow: OverflowInfo
  /** Scale chosen — useful for debug / preview rendering */
  scale: number
  /** Zoom mode used for this image */
  zoomMode: 'auto_zoom' | 'contain'
}

export interface HeadSpaceConfig {
  headSpacePx: number
  leftMarginPx: number
  rightMarginPx: number
  bottomMarginPx: number
  autoCenterHorizontally: boolean
  /** v2: when true, zoom product UP so head exactly touches guide line */
  autoZoom: boolean
  /** v2: when true, allow product to overflow canvas (caller triggers AI Extend) */
  allowAiExtend: boolean
  /** v2: never let the product be cropped — reduce zoom if overflow cannot be extended */
  protectFullProduct: boolean
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Pixels with alpha below this threshold are considered transparent / empty */
const ALPHA_THRESHOLD = 20

/** Downscale to this dimension before pixel-scanning — keeps detection to ~1–3ms */
const MAX_ANALYSIS_DIM = 800

// ─── Pixel Bounding Box Detection ─────────────────────────────────────────────

/**
 * Find the axis-aligned bounding box of non-transparent pixels.
 *
 * For transparent PNGs (post background-removal): detects the actual product
 * silhouette boundary — head pixel at top, feet/hem at bottom.
 *
 * For opaque JPEGs: hasTransparency=false, bounds = full image size.
 * The compositor still applies head-space logic using the full image rectangle,
 * giving consistent top margin + centered fit across all products.
 *
 * Server-only — uses @napi-rs/canvas.
 */
export async function detectProductBounds(imageUrl: string): Promise<ProductBounds> {
  const img = await loadImage(imageUrl)
  const imgW = img.width
  const imgH = img.height

  // Downscale for speed — we only need approximate bounds; the scale factor
  // converts analysis-space coordinates back to original-image space.
  const scale = Math.min(1, MAX_ANALYSIS_DIM / Math.max(imgW, imgH))
  const analysisW = Math.max(1, Math.round(imgW * scale))
  const analysisH = Math.max(1, Math.round(imgH * scale))

  const tempCanvas = createCanvas(analysisW, analysisH)
  const ctx = tempCanvas.getContext('2d')
  ctx.drawImage(img as any, 0, 0, analysisW, analysisH)

  const imageData = ctx.getImageData(0, 0, analysisW, analysisH)
  const data = imageData.data  // RGBA flat array

  let minX = analysisW
  let minY = analysisH
  let maxX = 0
  let maxY = 0
  let hasTransparency = false

  for (let y = 0; y < analysisH; y++) {
    for (let x = 0; x < analysisW; x++) {
      const alpha = data[(y * analysisW + x) * 4 + 3]
      // Track whether ANY pixel has partial transparency
      if (alpha < 250) hasTransparency = true
      // A pixel is "visible" if alpha exceeds the threshold
      if (alpha > ALPHA_THRESHOLD) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }

  // Guard: fully transparent or empty image — fall back to full image bounds.
  // This prevents division-by-zero later and keeps the pipeline non-fatal.
  if (minX >= maxX || minY >= maxY) {
    return {
      left: 0, top: 0,
      right: imgW - 1, bottom: imgH - 1,
      imageWidth: imgW, imageHeight: imgH,
      hasTransparency: false,
    }
  }

  // Convert from analysis-space back to original-image coordinates
  return {
    left:   Math.max(0,         Math.round(minX / scale)),
    top:    Math.max(0,         Math.round(minY / scale)),
    right:  Math.min(imgW - 1,  Math.round(maxX / scale)),
    bottom: Math.min(imgH - 1,  Math.round(maxY / scale)),
    imageWidth:  imgW,
    imageHeight: imgH,
    hasTransparency,
  }
}

// ─── Smart Auto Zoom Placement ────────────────────────────────────────────────

/**
 * Calculate where to draw the product image on the canvas so that:
 *
 *  - TOP of the visible product content lands exactly at headSpacePx.
 *  - Product is never stretched or distorted — uniform scale only.
 *  - When autoZoom=true: product is zoomed UP so it fills the available
 *    height completely (head at guide, feet at bottom margin).
 *  - When autoZoom=false (legacy): uses contain-scale (no cropping, may
 *    leave empty space below the product).
 *
 * Returns both the pixel placement AND overflow information.
 * The caller (compositor) uses overflow to decide whether to run AI Extend.
 *
 * All coordinates are in 1× canvas pixel space.
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
    allowAiExtend,
    protectFullProduct,
  } = config

  const contentW = bounds.right  - bounds.left  // visible product width in original px
  const contentH = bounds.bottom - bounds.top   // visible product height

  const availableW = canvasW - leftMarginPx - rightMarginPx
  const availableH = canvasH - headSpacePx  - bottomMarginPx

  // Guard: degenerate geometry — return identity placement
  if (contentW <= 0 || contentH <= 0 || availableW <= 0 || availableH <= 0) {
    const fallbackScale = canvasW / bounds.imageWidth
    return {
      placement: { imgX: 0, imgY: 0, renderedW: canvasW, renderedH: canvasH, scale: fallbackScale },
      overflow: { left: 0, right: 0, top: 0, bottom: 0, hasOverflow: false },
      scale: fallbackScale,
      zoomMode: 'contain',
    }
  }

  let scale: number
  let zoomMode: 'auto_zoom' | 'contain'

  if (autoZoom) {
    // ── Smart Auto Zoom ────────────────────────────────────────────────────
    //
    // Zoom the product so its visible height exactly fills the available height.
    // This guarantees:
    //   - Head always at headSpacePx from canvas top (the guide line).
    //   - Every product rendered at the same physical height in the catalog.
    //
    // scaleToFillH = how big to make the image so contentH spans availableH.
    // This is the zoom factor that makes EVERY model the same height.
    //
    // We do NOT constrain by width here — if the product overflows horizontally,
    // the allowAiExtend flag lets the compositor extend the canvas sides.
    //
    const scaleToFillH = availableH / contentH

    if (protectFullProduct) {
      // Also check: does this zoom factor cause horizontal overflow?
      const scaledContentW = contentW * scaleToFillH
      if (scaledContentW > availableW && !allowAiExtend) {
        // Cannot extend AND cannot crop → fall back to contain so nothing is clipped.
        // This is the safety valve: protectFullProduct wins over autoZoom.
        scale = Math.min(availableW / contentW, availableH / contentH)
        zoomMode = 'contain'
      } else {
        // Either we can extend horizontally, or it already fits → use fill height.
        scale = scaleToFillH
        zoomMode = 'auto_zoom'
      }
    } else {
      scale = scaleToFillH
      zoomMode = 'auto_zoom'
    }
  } else {
    // ── Legacy contain mode ────────────────────────────────────────────────
    // Scale so the entire visible product fits within available area.
    // Head lands at headSpacePx; feet may not reach bottomMarginPx.
    // This is what the original Fit to Canvas did, but corrected to use
    // visible bounds instead of full image dimensions.
    scale = Math.min(availableW / contentW, availableH / contentH)
    zoomMode = 'contain'
  }

  // ── Rendered dimensions of the FULL source image at this scale ────────────
  const renderedW = bounds.imageWidth  * scale
  const renderedH = bounds.imageHeight * scale

  // ── Vertical positioning ──────────────────────────────────────────────────
  // We want: canvas_y_of_top_visible_pixel === headSpacePx
  // top_visible_pixel in canvas = imgY + bounds.top * scale
  // → imgY = headSpacePx - bounds.top * scale
  const imgY = headSpacePx - bounds.top * scale

  // ── Horizontal positioning ────────────────────────────────────────────────
  let imgX: number
  if (autoCenterHorizontally) {
    // Center the VISIBLE content (not the full image rect) in the available width
    const contentCenterOnCanvas = leftMarginPx + availableW / 2
    imgX = contentCenterOnCanvas - (bounds.left + contentW / 2) * scale
  } else {
    // Align left edge of visible content to left margin
    imgX = leftMarginPx - bounds.left * scale
  }

  // ── Overflow detection ────────────────────────────────────────────────────
  // Compute how many pixels of the scaled image fall outside the canvas.
  // "Overflow" = any part of the product's visible bounding box outside the
  // canvas boundary. We use the SCALED VISIBLE BOUNDS, not the full image rect.
  //
  // Note: top overflow should always be 0 because imgY is calculated to place
  // the head exactly at headSpacePx ≥ 0. We compute it anyway for correctness.
  //
  const scaledLeft   = imgX + bounds.left   * scale  // left edge of visible content on canvas
  const scaledTop    = imgY + bounds.top    * scale  // top of visible content = headSpacePx
  const scaledRight  = imgX + bounds.right  * scale  // right edge
  const scaledBottom = imgY + bounds.bottom * scale  // bottom of feet/hem/accessories

  const overflowLeft   = Math.max(0, -scaledLeft)           // bleed past left canvas edge
  const overflowTop    = Math.max(0, -scaledTop)            // bleed past top (should be ~0)
  const overflowRight  = Math.max(0, scaledRight  - canvasW) // bleed past right
  const overflowBottom = Math.max(0, scaledBottom - canvasH) // bleed past bottom

  const hasOverflow = overflowLeft > 0.5 || overflowTop > 0.5 ||
                      overflowRight > 0.5 || overflowBottom > 0.5

  return {
    placement: { imgX, imgY, renderedW, renderedH, scale },
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

/**
 * Convert a HeadSpacePlacement to ProductLayerSettings override.
 * This lets us slot the calculated placement into the existing
 * drawProductLayer pipeline without changing its API.
 *
 * @param placement  pixel-space placement (1× canvas)
 * @param canvasW    1× canvas width
 * @param canvasH    1× canvas height
 * @param base       existing settings (shadow, glow, effects inherited)
 */
export function placementToProductLayerSettings(
  placement: HeadSpacePlacement,
  canvasW: number,
  canvasH: number,
  base: typeof DEFAULT_PRODUCT_LAYER_SETTINGS
): typeof DEFAULT_PRODUCT_LAYER_SETTINGS {
  return {
    ...base,
    // Convert pixel coordinates to percentages of canvas
    x:      (placement.imgX      / canvasW) * 100,
    y:      (placement.imgY      / canvasH) * 100,
    width:  (placement.renderedW / canvasW) * 100,
    height: (placement.renderedH / canvasH) * 100,
    // 'fill' = draw at exactly the calculated dimensions.
    // drawProductLayer must NOT do its own contain/cover scaling when we give it
    // pixel-exact placement — our calculation already handles fit correctly.
    objectFit: 'fill',
    // No additional padding — margins are baked into imgX/imgY
    padding: 0,
  }
}

// ─── Overflow → AI Extend parameters ─────────────────────────────────────────

/**
 * When the zoomed product overflows, we need to call AI Extend with an
 * EXPANDED canvas so the product fits naturally.
 *
 * Returns the extended canvas dimensions (same center, larger area).
 * The compositor uses these to call getExtendedImage with the larger canvas.
 *
 * Strategy:
 *  - Expand canvas symmetrically if overflow is on both sides.
 *  - Expand only in the overflowing direction otherwise.
 *  - Always expand in multiples of 8px for Cloudinary efficiency.
 */
export function computeExtendedCanvasDimensions(
  canvasW: number,
  canvasH: number,
  overflow: OverflowInfo
): { extW: number; extH: number; offsetX: number; offsetY: number } {
  const roundUp8 = (n: number) => Math.ceil(n / 8) * 8

  // Extra pixels needed on each side
  const extraLeft   = roundUp8(overflow.left   + 20)  // +20px padding for natural look
  const extraRight  = roundUp8(overflow.right  + 20)
  const extraBottom = roundUp8(overflow.bottom + 20)
  const extraTop    = roundUp8(overflow.top)           // usually 0

  const extW = canvasW + (overflow.left  > 0.5 ? extraLeft  : 0)
                       + (overflow.right > 0.5 ? extraRight : 0)
  const extH = canvasH + (overflow.top    > 0.5 ? extraTop    : 0)
                       + (overflow.bottom > 0.5 ? extraBottom : 0)

  // Where the original canvas origin appears in the extended canvas
  const offsetX = overflow.left > 0.5 ? extraLeft : 0
  const offsetY = overflow.top  > 0.5 ? extraTop  : 0

  return { extW, extH, offsetX, offsetY }
}