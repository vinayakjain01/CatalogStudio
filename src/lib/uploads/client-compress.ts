/**
 * Browser-side image preparation, applied only when a file exceeds the request
 * body ceiling (CLIENT_MAX_UPLOAD_BYTES).
 *
 * WHY THIS EXISTS: the Drive import downloaded bytes server-to-server, so a
 * 20 MB photo never crossed a request boundary. A browser folder upload does,
 * and Vercel rejects serverless request bodies over ~4.5 MB with a 413 before
 * our handler ever runs. Shrinking a photo slightly beats failing the import.
 *
 * PERFORMANCE IS THE WHOLE DESIGN HERE. Studio catalog exports are routinely
 * 5464×8192 (≈45 megapixels, ~15 MB). The naive shape — encode at full
 * resolution, check the size, drop the quality, encode again — costs up to ten
 * 45 MP encodes per image and minutes per folder. Instead:
 *
 *   1. decode once,
 *   2. draw ONE downscaled canvas capped at MAX_UPLOAD_EDGE,
 *   3. release the full-resolution bitmap immediately (~180 MB of RGBA),
 *   4. iterate quality on that small canvas WITHOUT redrawing it.
 *
 * That is one decode plus one draw, versus ten full-resolution encodes.
 *
 * TRANSPARENCY IS LOAD-BEARING: PNGs in a product folder are frequently
 * cut-outs with an alpha channel, and the background-removal / product-layer
 * pipeline downstream depends on that channel. Those are resized but never
 * converted to JPEG, which would flatten alpha to black. A PNG that turns out
 * to be fully opaque (a photo exported as PNG — common, and very expensive to
 * keep lossless) is treated as a photo instead.
 */
import { CLIENT_MAX_UPLOAD_BYTES, fileExtension, stripExtension } from './image-files'

/**
 * Longest-edge cap for uploaded images.
 *
 * Sized off what generation can actually consume: the largest template canvas
 * is 1920px on its longest edge (ASPECT_RATIOS in types/template.ts) and the
 * compositor supersamples 2× (SUPERSAMPLE in lib/compositor.ts), so the render
 * target tops out near 3840px — and a product layer occupies ~80% of it by
 * default. 3200px therefore stays above everything the pipeline can use, while
 * taking a 45 MP studio original down to under 7 MP.
 */
export const MAX_UPLOAD_EDGE = 3200

/** Quality steps, all applied to the same already-downscaled canvas. */
const QUALITY_LADDER = [0.9, 0.82, 0.74, 0.66, 0.58]

/** Extra dimension steps, only reached if the cap alone wasn't enough. */
const FALLBACK_SCALES = [0.75, 0.55, 0.4]

export interface PreparedUpload {
  blob: Blob
  /** Filename to send — changes extension when the format was converted. */
  filename: string
  compressed: boolean
  /**
   * Dimensions of the ORIGINAL image, when we had to decode it anyway.
   *
   * Reported back so the preview grid can label a file it never rendered:
   * paginated tiles frequently finish uploading before they are ever scrolled
   * to, and re-decoding a 45 MP original purely to measure it would undo the
   * saving this module exists for.
   */
  sourceWidth?: number
  sourceHeight?: number
}

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement

/**
 * The 2D context surface we use. Declared structurally because the DOM and
 * Offscreen context types are unrelated in TypeScript despite sharing these
 * members, and a union would break `drawImage` overload resolution.
 */
interface Canvas2D {
  imageSmoothingEnabled: boolean
  imageSmoothingQuality: ImageSmoothingQuality
  drawImage(image: CanvasImageSource, dx: number, dy: number, dw: number, dh: number): void
  getImageData(sx: number, sy: number, sw: number, sh: number): ImageData
}

function createCanvas(width: number, height: number): { canvas: AnyCanvas; ctx: Canvas2D } | null {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    return { canvas, ctx: ctx as unknown as Canvas2D }
  }

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  return { canvas, ctx: ctx as unknown as Canvas2D }
}

async function toBlob(
  canvas: AnyCanvas,
  type: 'image/jpeg' | 'image/png',
  quality?: number
): Promise<Blob | null> {
  if ('convertToBlob' in canvas) {
    try {
      return await canvas.convertToBlob({ type, quality })
    } catch {
      return null
    }
  }
  return new Promise<Blob | null>(resolve => {
    canvas.toBlob(blob => resolve(blob), type, quality)
  })
}

/** Scale a source onto a fresh canvas of the given size. */
function drawScaled(
  source: CanvasImageSource,
  width: number,
  height: number
): { canvas: AnyCanvas; ctx: Canvas2D } | null {
  const target = createCanvas(width, height)
  if (!target) return null
  target.ctx.imageSmoothingEnabled = true
  target.ctx.imageSmoothingQuality = 'high'
  target.ctx.drawImage(source, 0, 0, width, height)
  return target
}

/**
 * Does this image actually use its alpha channel?
 *
 * Runs on the ALREADY-DOWNSCALED canvas, so it scans ~7 M pixels rather than
 * 45 M. Any failure (a tainted canvas, an out-of-memory read) answers "yes",
 * because the safe default is to preserve the channel.
 */
function hasTransparency(ctx: Canvas2D, width: number, height: number): boolean {
  try {
    const { data } = ctx.getImageData(0, 0, width, height)
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 255) return true
    }
    return false
  } catch {
    return true
  }
}

/**
 * Return upload-ready bytes for a file.
 *
 * Files already under the limit are passed through untouched — the common case,
 * and the one where we must not degrade quality. If decoding or re-encoding
 * fails we fall back to the smallest result we managed (or the original), rather
 * than failing the item: self-hosted deployments have no 4.5 MB ceiling, so the
 * upload may well succeed anyway.
 */
export async function prepareImageForUpload(file: File): Promise<PreparedUpload> {
  const passthrough: PreparedUpload = { blob: file, filename: file.name, compressed: false }

  if (file.size <= CLIENT_MAX_UPLOAD_BYTES) return passthrough

  let bitmap: ImageBitmap | null = null
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    return passthrough
  }

  const sourceWidth = bitmap.width
  const sourceHeight = bitmap.height
  /** Attach the measurements we already have to whatever we end up returning. */
  const withDims = (p: PreparedUpload): PreparedUpload => ({ ...p, sourceWidth, sourceHeight })

  /** Best (smallest) candidate produced so far, so no work is ever wasted. */
  let best: PreparedUpload | null = null
  const consider = (blob: Blob | null, filename: string) => {
    if (!blob) return false
    if (!best || blob.size < best.blob.size) best = { blob, filename, compressed: true }
    return blob.size <= CLIENT_MAX_UPLOAD_BYTES
  }
  /** Smallest candidate if we actually improved on the original, else the original. */
  const bestOrOriginal = () =>
    withDims(best && (best as PreparedUpload).blob.size < file.size ? best : passthrough)

  try {
    const scale = Math.min(1, MAX_UPLOAD_EDGE / Math.max(sourceWidth, sourceHeight))
    const width = Math.max(1, Math.round(sourceWidth * scale))
    const height = Math.max(1, Math.round(sourceHeight * scale))

    const capped = drawScaled(bitmap, width, height)
    if (!capped) return withDims(passthrough)

    // Release the full-resolution decode before doing anything else — at 45 MP
    // this frees roughly 180 MB, which matters with several uploads in flight.
    bitmap.close()
    bitmap = null

    const looksPng = file.type === 'image/png' || fileExtension(file.name) === 'png'
    const keepLossless = looksPng && hasTransparency(capped.ctx, width, height)

    if (keepLossless) {
      // Alpha-safe path: PNG has no quality knob, so only dimensions can give.
      if (consider(await toBlob(capped.canvas, 'image/png'), file.name)) return withDims(best!)

      for (const s of FALLBACK_SCALES) {
        const smaller = drawScaled(capped.canvas, Math.round(width * s), Math.round(height * s))
        if (!smaller) break
        if (consider(await toBlob(smaller.canvas, 'image/png'), file.name)) return withDims(best!)
      }

      return bestOrOriginal()
    }

    // Lossy path: same canvas every iteration — quality only, no redraw.
    const jpegName = `${stripExtension(file.name)}.jpg`

    for (const quality of QUALITY_LADDER) {
      if (consider(await toBlob(capped.canvas, 'image/jpeg', quality), jpegName)) return withDims(best!)
    }

    // Essentially unreachable at 3200px, but keeps the contract honest.
    for (const s of FALLBACK_SCALES) {
      const smaller = drawScaled(capped.canvas, Math.round(width * s), Math.round(height * s))
      if (!smaller) break
      if (consider(await toBlob(smaller.canvas, 'image/jpeg', 0.8), jpegName)) return withDims(best!)
    }

    return bestOrOriginal()
  } catch {
    return bestOrOriginal()
  } finally {
    bitmap?.close()
  }
}
