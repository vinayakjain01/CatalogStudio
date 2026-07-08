/**
 * Pixel bounding-box detection — server-only (uses @napi-rs/canvas).
 *
 * Originally lived inside product-positioning.ts (Head Space), but Background
 * Reconstruction needs the exact same "where is the product in this image"
 * detection to know which region to hand to Cloudinary's Generative Remove.
 * Extracted here as a neutral, feature-agnostic utility both import.
 */

import { createCanvas, loadImage } from '@napi-rs/canvas'
import type { ProductBounds } from '@/lib/product-positioning-shared'

export type { ProductBounds }

/**
 * Strip Shopify/Cloudinary/etc resize params so bounds-detection loads the same
 * pixel dimensions the compositor's toHighQualityUrl() will draw — otherwise the
 * scale/region calculated here won't match the image actually rendered.
 */
export function stripResizeParams(src: string): string {
  if (!src) return src
  try {
    let r = src.replace(/_([\d]+)x([\d]+)?(@[\d]x)?(\.(?:jpg|jpeg|png|webp|gif))(\?.*)?$/i, '$4$5')
    r = r.replace(/\/upload\/([^/]+)\/(?=v\d+\/)/, (m, t) => (/^v\d+$/.test(t) ? m : '/upload/'))
    return r
  } catch {
    return src
  }
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
