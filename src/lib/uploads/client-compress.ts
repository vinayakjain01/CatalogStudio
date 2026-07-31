/**
 * Browser-side image downscaling, applied only when a file exceeds the request
 * body ceiling (CLIENT_MAX_UPLOAD_BYTES).
 *
 * WHY THIS EXISTS: the Drive import downloaded bytes server-to-server, so a
 * 20 MB photo never crossed a request boundary. A browser folder upload does,
 * and Vercel rejects serverless request bodies over ~4.5 MB with a 413 before
 * our handler ever runs. Shrinking a photo slightly beats failing the import.
 *
 * TRANSPARENCY IS LOAD-BEARING: PNGs in a product folder are frequently
 * cut-outs with an alpha channel, and the background-removal / product-layer
 * pipeline downstream depends on that channel. Re-encoding them as JPEG would
 * flatten alpha to black and silently corrupt those creatives — so PNGs are only
 * ever resized (staying PNG, lossless), never converted. Lossy formats get a
 * quality ladder first, which preserves dimensions.
 */
import { CLIENT_MAX_UPLOAD_BYTES, fileExtension, stripExtension } from './image-files'

export interface PreparedUpload {
  blob: Blob
  /** Filename to send — changes extension when the format was converted. */
  filename: string
  compressed: boolean
}

/** Quality steps for lossy formats — dimensions preserved. */
const QUALITY_LADDER = [0.92, 0.85, 0.78, 0.7, 0.6]

/** Dimension steps, used once quality alone cannot get under the limit. */
const SCALE_LADDER = [0.85, 0.7, 0.55, 0.45, 0.35]

async function encode(
  bitmap: ImageBitmap,
  scale: number,
  type: 'image/jpeg' | 'image/png',
  quality?: number
): Promise<Blob | null> {
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))

  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(bitmap, 0, 0, width, height)
    return canvas.convertToBlob({ type, quality })
  }

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(bitmap, 0, 0, width, height)

  return new Promise<Blob | null>(resolve => {
    canvas.toBlob(blob => resolve(blob), type, quality)
  })
}

/**
 * Return upload-ready bytes for a file.
 *
 * Files already under the limit are passed through untouched — the common case,
 * and the one where we must not degrade quality. If decoding or re-encoding
 * fails we return the original rather than failing the item: self-hosted
 * deployments have no 4.5 MB ceiling, so the upload may well succeed anyway.
 */
export async function prepareImageForUpload(file: File): Promise<PreparedUpload> {
  if (file.size <= CLIENT_MAX_UPLOAD_BYTES) {
    return { blob: file, filename: file.name, compressed: false }
  }

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    return { blob: file, filename: file.name, compressed: false }
  }

  try {
    const isPng = file.type === 'image/png' || fileExtension(file.name) === 'png'

    if (isPng) {
      // Alpha-safe path: resize only, keep PNG.
      for (const scale of SCALE_LADDER) {
        const blob = await encode(bitmap, scale, 'image/png')
        if (blob && blob.size <= CLIENT_MAX_UPLOAD_BYTES) {
          return { blob, filename: file.name, compressed: true }
        }
      }
      return { blob: file, filename: file.name, compressed: false }
    }

    // Lossy path: drop quality before dimensions.
    const jpegName = `${stripExtension(file.name)}.jpg`

    for (const quality of QUALITY_LADDER) {
      const blob = await encode(bitmap, 1, 'image/jpeg', quality)
      if (blob && blob.size <= CLIENT_MAX_UPLOAD_BYTES) {
        return { blob, filename: jpegName, compressed: true }
      }
    }

    for (const scale of SCALE_LADDER) {
      const blob = await encode(bitmap, scale, 'image/jpeg', 0.85)
      if (blob && blob.size <= CLIENT_MAX_UPLOAD_BYTES) {
        return { blob, filename: jpegName, compressed: true }
      }
    }

    return { blob: file, filename: file.name, compressed: false }
  } catch {
    return { blob: file, filename: file.name, compressed: false }
  } finally {
    bitmap.close()
  }
}
