import { v2 as cloudinary } from 'cloudinary'
import { logPerf } from '@/lib/perf'

cloudinary.config({
  cloud_name: process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
})

/**
 * Upload the lossless PNG master produced by the compositor.
 *
 * Key change vs. the old version:
 *  - We DO NOT force `format: 'jpg'` or transform on upload. The stored
 *    original stays lossless (and keeps transparency).
 *  - The lossy/format optimisation is applied ONCE, on delivery, by
 *    rewriting the secure_url with `f_auto,q_auto:good`. Browsers get
 *    WebP/AVIF at a good quality, the master on disk is untouched.
 *
 * This eliminates the double-JPEG that was causing artifacts and colour
 * shift. `deliveredUrl` is what you store/show; `url` is the raw master.
 */
export async function uploadBuffer(
  buffer: Buffer,
  publicId: string
): Promise<{ url: string; deliveredUrl: string; publicId: string }> {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    cloudinary.uploader
      .upload_stream(
        {
          public_id: publicId,
          folder: 'catalog-creatives',
          overwrite: true,
          resource_type: 'image',
          // No `format` and no upload-time transformation:
          // keep the original PNG master lossless.
        },
        (error, result) => {
          logPerf('cloudinary.upload.stream', Date.now() - started, {
            publicId,
            bytes: buffer.length,
            ok: Boolean(!error && result),
          })
          if (error || !result) return reject(error)
          resolve({
            url: result.secure_url,
            deliveredUrl: toDeliveryUrl(result.secure_url),
            publicId: result.public_id,
          })
        }
      )
      .end(buffer)
  })
}

/**
 * Insert delivery transforms into a Cloudinary URL. Inserts right after `/upload/`.
 *
 *   .../image/upload/v123/foo.png
 *   .../image/upload/f_auto,q_auto:best,dpr_auto,fl_progressive/v123/foo.png
 *
 * f_auto       — WebP/AVIF for browsers that support it; JPEG fallback.
 * q_auto:best  — highest quality automatic compression (vs :good which is lower).
 * dpr_auto     — serve 2× pixels on Retina/HiDPI screens automatically.
 *                On a Retina display showing the image at 1024px, Cloudinary
 *                delivers 2048px — zero blurriness at 1:1 pixel mapping.
 * fl_progressive — progressive JPEG loading (first pass shows full image at
 *                  lower quality, subsequent passes sharpen — feels faster).
 *
 * For luxury fashion catalog creatives, quality > file size at every step.
 */
export function toDeliveryUrl(secureUrl: string, extra?: string): string {
  const transform = ['f_auto', 'q_auto:best', 'dpr_auto', 'fl_progressive', extra]
    .filter(Boolean)
    .join(',')
  return secureUrl.replace('/upload/', `/upload/${transform}/`)
}

export async function deleteImage(publicId: string): Promise<void> {
  await cloudinary.uploader.destroy(publicId)
}