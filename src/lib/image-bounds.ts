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

// ─── Product Zoom Mode: subject bounds for OPAQUE photos ─────────────────────
//
// detectProductBounds() above only works via the alpha channel — for an
// opaque photo (Product Zoom Mode's entire input type: original, unmodified
// photography, never background-removed) there is no alpha to scan, so it
// degrades to "bounds = the full image rect." Feeding that into Head Space
// placement math makes the whole photo shift by the configured Head Space
// value instead of aligning the actual subject — visible as empty canvas
// padding above the image.
//
// This is a separate, additive detector (detectProductBounds is untouched,
// so Standard Mode's existing behavior — including its own known limitation
// on opaque images — is unaffected). It locates the subject by contrast
// against the studio backdrop instead of transparency: catalog photography
// is almost always shot on a plain/seamless backdrop, so sampling a thin
// border ring gives a reliable backdrop-color estimate, and pixels that
// differ from it beyond a threshold are the subject. No AI call, no network
// round trip beyond the one image fetch — a single local pixel pass, same
// cost class as detectProductBounds.
//
// Falls back to the same "full image rect" shape as detectProductBounds
// whenever it isn't confident (backdrop can't be modeled smoothly, or the
// color split looks wrong) — callers must treat that fallback as "don't
// trust these bounds" (see isDegenerateBounds in
// product-positioning-shared.ts), not silently apply Head Space against it
// and reproduce the padding bug.
//
// v2: the backdrop is modeled as a smooth bilinear gradient across the 4
// corners rather than one flat average color. A single global average (v1)
// treated any lighting falloff/vignette — which is present in virtually all
// real studio photography, even on an otherwise "plain" backdrop — as
// texture/noise and bailed out to the safe fallback almost every time,
// silently no-opping the whole feature on real photos. Modeling the gradient
// means only genuine local contrast (the actual subject, or real texture/
// pattern the gradient model can't explain) trips detection.

const BG_CORNER_FRACTION = 0.06      // corner sample patch size, as a fraction of each dimension
const BG_MIN_CORNER_PX = 3
const BG_BORDER_FRACTION = 0.015     // ring thickness (for the residual/confidence check), fraction of shorter side
const BG_MIN_BORDER_PX = 2
const BG_COLOR_DISTANCE_THRESHOLD = 36  // 0–441 (max possible RGB Euclidean distance)
const BG_MAX_RESIDUAL_STDDEV = 50       // Relaxed from 28 → 50: studio backdrops vary from smooth
                                        // gradients to rough concrete/stucco. 28 rejects many
                                        // legitimate plain backdrops. 50 still rejects heavily
                                        // patterned fabrics while accepting real studio textures.
const MIN_FOREGROUND_FRACTION = 0.005   // below this, treat as "nothing confidently detected"
const MAX_FOREGROUND_FRACTION = 0.98    // above this, backdrop model was probably wrong

interface RgbTriple { r: number; g: number; b: number }

function averageCornerColor(data: Uint8ClampedArray, w: number, x0: number, y0: number, x1: number, y1: number): RgbTriple {
  let r = 0, g = 0, b = 0, n = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4
      r += data[i]; g += data[i + 1]; b += data[i + 2]
      n++
    }
  }
  return n > 0 ? { r: r / n, g: g / n, b: b / n } : { r: 0, g: 0, b: 0 }
}

/** Bilinear blend of the 4 corner colors at normalized position (u, v) in [0, 1]. */
function bilerpColor(tl: RgbTriple, tr: RgbTriple, bl: RgbTriple, br: RgbTriple, u: number, v: number): RgbTriple {
  const topR = tl.r + (tr.r - tl.r) * u, topG = tl.g + (tr.g - tl.g) * u, topB = tl.b + (tr.b - tl.b) * u
  const botR = bl.r + (br.r - bl.r) * u, botG = bl.g + (br.g - bl.g) * u, botB = bl.b + (br.b - bl.b) * u
  return {
    r: topR + (botR - topR) * v,
    g: topG + (botG - topG) * v,
    b: topB + (botB - topB) * v,
  }
}

export async function detectZoomSubjectBounds(imageUrl: string): Promise<ProductBounds> {
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
  const data = ctx.getImageData(0, 0, analysisW, analysisH).data

  const fullImageRect = (): ProductBounds => ({
    left: 0, top: 0,
    right: imgW - 1, bottom: imgH - 1,
    imageWidth: imgW, imageHeight: imgH,
    hasTransparency: false,
  })

  // ── Step 1: model the backdrop as a smooth bilinear gradient ──────────────
  // Sample a small patch at each corner — the 4 spots least likely to contain
  // the subject in typical catalog framing — and treat everything between
  // them as a smooth blend. This absorbs lighting falloff/vignettes for free.
  const patchW = Math.max(BG_MIN_CORNER_PX, Math.round(analysisW * BG_CORNER_FRACTION))
  const patchH = Math.max(BG_MIN_CORNER_PX, Math.round(analysisH * BG_CORNER_FRACTION))
  const tl = averageCornerColor(data, analysisW, 0, 0, patchW, patchH)
  const tr = averageCornerColor(data, analysisW, analysisW - patchW, 0, analysisW, patchH)
  const bl = averageCornerColor(data, analysisW, 0, analysisH - patchH, patchW, analysisH)
  const br = averageCornerColor(data, analysisW, analysisW - patchW, analysisH - patchH, analysisW, analysisH)

  // ── Step 2: confidence check — does a thin border ring actually FIT the ───
  // modeled gradient, or is there real texture/pattern the model can't
  // explain? (A residual check, not a raw-variance check — a smooth gradient
  // has high raw variance corner-to-corner but near-zero residual once the
  // model is subtracted out.)
  const borderPx = Math.max(BG_MIN_BORDER_PX, Math.round(Math.min(analysisW, analysisH) * BG_BORDER_FRACTION))
  let residualSumSq = 0, residualN = 0
  const addResidual = (x: number, y: number) => {
    const i = (y * analysisW + x) * 4
    const expected = bilerpColor(tl, tr, bl, br, x / (analysisW - 1), y / (analysisH - 1))
    const dr = data[i] - expected.r, dg = data[i + 1] - expected.g, db = data[i + 2] - expected.b
    residualSumSq += dr * dr + dg * dg + db * db
    residualN++
  }
  for (let x = 0; x < analysisW; x++) {
    for (let t = 0; t < borderPx; t++) { addResidual(x, t); addResidual(x, analysisH - 1 - t) }
  }
  for (let y = 0; y < analysisH; y++) {
    for (let t = 0; t < borderPx; t++) { addResidual(t, y); addResidual(analysisW - 1 - t, y) }
  }
  if (residualN === 0) return fullImageRect()

  const residualStddev = Math.sqrt(residualSumSq / residualN)
  if (residualStddev > BG_MAX_RESIDUAL_STDDEV) {
    // The bilinear-gradient model couldn't explain the border ring — backdrop is
    // either textured/patterned OR the subject is large enough to bleed into the
    // corners/border. Try a row-variance fallback before giving up entirely.
    //
    // Row-variance strategy: for each row, compute the mean color difference
    // between adjacent pixels (horizontal variation). Background rows are smooth
    // (low variation); rows that contain the subject have edges/texture (high
    // variation). This is reliable for fashion-on-seamless-backdrop images where
    // the backdrop — even a textured one — is horizontally smoother than clothing.
    const rowVariance = new Float32Array(analysisH)
    for (let y = 0; y < analysisH; y++) {
      let sumDiff = 0
      for (let x = 1; x < analysisW; x++) {
        const i = (y * analysisW + x) * 4
        const j = i - 4
        const dr = data[i] - data[j], dg = data[i+1] - data[j+1], db = data[i+2] - data[j+2]
        sumDiff += Math.sqrt(dr*dr + dg*dg + db*db)
      }
      rowVariance[y] = sumDiff / (analysisW - 1)
    }

    // Threshold: use the TOP and BOTTOM border rows (5% of frame height) as
    // the backdrop baseline rather than the per-image median. Using the median
    // fails when the model fills >50% of the frame — more than half the rows
    // come from the high-variance subject, so the median is a subject-row value,
    // not a backdrop value. The threshold ends up too high → nothing detected →
    // returns fullImageRect (degenerate bounds) and the head-space bug fires.
    // Border rows are almost always pure backdrop in catalog photography, so
    // they give a reliable baseline regardless of how tightly the model is framed.
    const borderSize = Math.max(2, Math.floor(analysisH * 0.05))
    const borderRowValues: number[] = [
      ...Array.from(rowVariance.slice(0, borderSize)),
      ...Array.from(rowVariance.slice(Math.max(0, analysisH - borderSize))),
    ]
    const backdropBaseline = borderRowValues.reduce((a, b) => a + b, 0) / Math.max(1, borderRowValues.length)
    const varThreshold = Math.max(backdropBaseline * 2.0, 3.0)

    let varMinY = -1, varMaxY = -1
    for (let y = 0; y < analysisH; y++) {
      if (rowVariance[y] > varThreshold) {
        if (varMinY === -1) varMinY = y
        varMaxY = y
      }
    }

    if (varMinY === -1 || varMaxY - varMinY < analysisH * 0.05) {
      // Row-variance also couldn't find anything meaningful — genuine fallback
      return fullImageRect()
    }

    // ── Feet-visibility guard ─────────────────────────────────────────────────
    // Count low-variance rows BELOW the detected subject. For a proper full-body
    // shot, the photographer leaves a floor / shadow region below the model's
    // feet — those rows have variance ≤ varThreshold (similar to the backdrop).
    // For a half-body or close-up shot, the garment fills to the very bottom of
    // the frame; there are no low-variance floor rows at all.
    //
    // If fewer than 4% of the analysed height are visible floor rows, we conclude
    // the feet are cut off and return degenerate bounds so the compositor skips
    // head-space framing entirely. A plain contain-fit is always better than
    // zooming 3-5× into a waist or generating an extreme fabric close-up.
    let floorRows = 0
    for (let y = varMaxY + 1; y < analysisH; y++) {
      if (rowVariance[y] <= varThreshold) floorRows++
    }
    const minFloorRows = Math.max(3, Math.floor(analysisH * 0.04))

    if (floorRows < minFloorRows) {
      // Feet not visible — half-body or close-up shot, skip framing
      return fullImageRect()
    }

    // ── Head-visibility guard ─────────────────────────────────────────────────
    // Count low-variance backdrop rows ABOVE the detected subject top.
    // Two checks:
    //
    // 1. MINIMUM (2%): if the subject starts at or above the very top edge, the
    //    head may be cut off → return degenerate.
    //
    // 2. MAXIMUM (20%): if there is TOO MUCH backdrop above the detected subject
    //    top, the top of the subject is likely a WAIST or HIP (lower-body shot),
    //    not an actual head. A real full-body catalog photo has the model's head
    //    within the top 20% of the frame; a lower-body shot has the waist at
    //    25–35% from the top with blank backdrop above.
    //    With a 20% ceiling: full-body shots pass (head at 5–15%), lower-body
    //    shots return degenerate (waist at 20–35%) → plain contain-fit.
    let headBackdropRows = 0
    for (let y = 0; y < varMinY; y++) {
      if (rowVariance[y] <= varThreshold) headBackdropRows++
    }
    const minHeadBackdrop = Math.max(2, Math.floor(analysisH * 0.02))
    const maxHeadBackdrop = Math.floor(analysisH * 0.20)

    if (headBackdropRows < minHeadBackdrop) {
      // Head cut off or too close to the top edge — skip framing
      return fullImageRect()
    }
    if (headBackdropRows > maxHeadBackdrop) {
      // Too much backdrop above — subject top is a waist/hip, not a head
      // (lower-body shot: legs only, no head in frame) — skip framing
      return fullImageRect()
    }

    // Row-variance found the subject rows — scale back to image coordinates
    // and use a 5% horizontal inset as a rough left/right estimate (most
    // catalog photography centers the subject horizontally)
    const topResult    = Math.max(0,        Math.round(varMinY / scale))
    const bottomResult = Math.min(imgH - 1, Math.round(varMaxY / scale))
    const leftResult   = Math.max(0,        Math.round(analysisW * 0.05 / scale))
    const rightResult  = Math.min(imgW - 1, Math.round(analysisW * 0.95 / scale))

    return {
      left: leftResult, top: topResult,
      right: rightResult, bottom: bottomResult,
      imageWidth: imgW, imageHeight: imgH,
      // FIX: zoom-mode images are opaque (no alpha channel). Setting hasTransparency: true
      // caused classifyShotType to use the detailed transparency-based classifier
      // (designed for AI cutout images) instead of the simple opaque aspect-ratio
      // classifier. Result: portrait walking-pose photos got classified as 'half_body'
      // instead of 'full_body', so selecting only "Full Body" never applied framing.
      // With hasTransparency: false and opaqueFullBodyAspectRatio: 0.85, any portrait
      // photo (height ≥ 85% of width) → 'full_body'. Only landscape photos → 'flat_lay'.
      hasTransparency: false,
    }
  }

  // ── Step 3: bounding box of pixels that differ from their local modeled ───
  // background color.
  let minX = analysisW, minY = analysisH, maxX = 0, maxY = 0, fgCount = 0
  for (let y = 0; y < analysisH; y++) {
    const v = y / (analysisH - 1)
    for (let x = 0; x < analysisW; x++) {
      const u = x / (analysisW - 1)
      const expected = bilerpColor(tl, tr, bl, br, u, v)
      const i = (y * analysisW + x) * 4
      const dr = data[i] - expected.r, dg = data[i + 1] - expected.g, db = data[i + 2] - expected.b
      if (Math.sqrt(dr * dr + dg * dg + db * db) > BG_COLOR_DISTANCE_THRESHOLD) {
        fgCount++
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }

  const totalPx = analysisW * analysisH
  if (
    minX >= maxX || minY >= maxY ||
    fgCount < totalPx * MIN_FOREGROUND_FRACTION ||
    fgCount > totalPx * MAX_FOREGROUND_FRACTION
  ) {
    return fullImageRect()
  }

  return {
    left:   Math.max(0,        Math.round(minX / scale)),
    top:    Math.max(0,        Math.round(minY / scale)),
    right:  Math.min(imgW - 1, Math.round(maxX / scale)),
    bottom: Math.min(imgH - 1, Math.round(maxY / scale)),
    imageWidth:  imgW,
    imageHeight: imgH,
    // See file header: this signals "trust these bounds as real subject
    // content" — the same contract computeClassificationSignals() /
    // classifyShotType() already read this field for, regardless of whether
    // detection came from an alpha channel or, as here, backdrop contrast.
    hasTransparency: true,
  }
}

const VERIFY_SAMPLE_SIZE = 48
const MIN_MEAN_DIFF = 10 // out of 255 per channel

/**
 * Cloudinary Generative Remove can return an HTTP-200 "success" whose eager
 * transform barely touched the requested region — there's no status field
 * for "the call succeeded but the object is still visible". Sample the
 * removal region from both the original and the result at low resolution and
 * compare; if they're nearly identical, the product almost certainly wasn't
 * actually removed, and the caller should treat this as a failure rather
 * than trust it as a clean background plate.
 */
/**
 * Both callers pass Cloudinary-hosted URLs (the uploaded base image and its
 * eager-transform result) — insert a crop+scale transformation so we fetch
 * and decode a ~48x48 sample directly instead of the full-resolution image.
 * Generation jobs already hold several full-res canvases in memory at once;
 * decoding two more multi-megapixel images just to diff a tiny region is
 * avoidable memory pressure on constrained worker hosts.
 */
function cloudinaryCroppedUrl(
  url: string,
  region: { x: number; y: number; w: number; h: number },
  size: number
): string | null {
  if (!url.includes('/upload/')) return null
  const transform =
    `c_crop,x_${Math.max(0, Math.round(region.x))},y_${Math.max(0, Math.round(region.y))},` +
    `w_${Math.max(1, Math.round(region.w))},h_${Math.max(1, Math.round(region.h))}` +
    `/c_scale,w_${size},h_${size}`
  return url.replace('/upload/', `/upload/${transform}/`)
}

function readSample(img: any, size: number) {
  const canvas = createCanvas(size, size)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, 0, 0, size, size)
  return ctx.getImageData(0, 0, size, size).data
}

function sampleRegionFullRes(
  img: any,
  region: { x: number; y: number; w: number; h: number },
  size: number
) {
  const canvas = createCanvas(size, size)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, region.x, region.y, region.w, region.h, 0, 0, size, size)
  return ctx.getImageData(0, 0, size, size).data
}

export async function verifyRegionChanged(
  originalUrl: string,
  resultUrl: string,
  region: { x: number; y: number; w: number; h: number }
): Promise<boolean> {
  const croppedOriginal = cloudinaryCroppedUrl(originalUrl, region, VERIFY_SAMPLE_SIZE)
  const croppedResult = cloudinaryCroppedUrl(resultUrl, region, VERIFY_SAMPLE_SIZE)

  let a: any
  let b: any

  if (croppedOriginal && croppedResult) {
    const [origSample, resultSample] = await Promise.all([
      loadImage(croppedOriginal),
      loadImage(croppedResult),
    ])
    a = readSample(origSample, VERIFY_SAMPLE_SIZE)
    b = readSample(resultSample, VERIFY_SAMPLE_SIZE)
  } else {
    // Fallback for non-Cloudinary URLs — decodes full images.
    const [origImg, resultImg] = await Promise.all([
      loadImage(originalUrl),
      loadImage(resultUrl),
    ])
    a = sampleRegionFullRes(origImg, region, VERIFY_SAMPLE_SIZE)
    b = sampleRegionFullRes(resultImg, region, VERIFY_SAMPLE_SIZE)
  }

  let totalDiff = 0
  const pixelCount = VERIFY_SAMPLE_SIZE * VERIFY_SAMPLE_SIZE
  for (let i = 0; i < a.length; i += 4) {
    totalDiff += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])
  }
  const meanDiff = totalDiff / (pixelCount * 3)

  return meanDiff >= MIN_MEAN_DIFF
}