/**
 * @module cloudinary
 *
 * Thin wrapper around the Cloudinary SDK for uploading rendered creatives and
 * building their optimized delivery URLs.
 *
 * RESPONSIBILITIES:
 *   - uploadBuffer — streams a compositor-rendered image buffer to Cloudinary.
 *   - toDeliveryUrl — inserts f_auto/q_auto:best delivery transforms into a
 *     Cloudinary URL.
 *   - deleteImage — removes an uploaded image by its Cloudinary public id.
 *
 * DEPENDENCIES: logPerf (@/lib/perf) to record upload timings.
 */
import { v2 as cloudinary } from 'cloudinary'
import { logPerf } from '@/lib/perf'

cloudinary.config({
  cloud_name: process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
})

/**
 * Upload the JPEG creative produced by the compositor.
 *
 * The compositor outputs JPEG at quality 92 (switched from PNG):
 *  - JPEG ~350KB vs PNG ~3.2MB → Cloudinary upload ~300ms vs ~3000ms
 *  - Cloudinary auto-detects the format from the buffer bytes (no `format` needed)
 *  - On delivery, f_auto,q_auto:best further optimises to WebP/AVIF for browsers
 *
 * No double-JPEG concern: q92 master → q_auto:best delivery is one extra
 * generation at the same or lower quality setting, indistinguishable visually.
 */
export async function uploadBuffer(
  buffer: Buffer,
  publicId: string,
  folder: string = 'catalog-creatives'
): Promise<{ url: string; deliveredUrl: string; publicId: string }> {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    cloudinary.uploader
      .upload_stream(
        {
          public_id: publicId,
          folder,
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
 * Insert delivery transforms into a Cloudinary URL. Inserts right after
 * `/upload/`. Safe to call once per URL.
 *
 *   .../image/upload/v123/foo.png
 *   .../image/upload/f_auto,q_auto:best/v123/foo.png
 *
 * q_auto:best — highest quality automatic optimization (vs :good which is lower).
 * For luxury fashion catalog creatives, quality > file size.
 */
export function toDeliveryUrl(secureUrl: string, extra?: string): string {
  const transform = ['f_auto', 'q_auto:best', extra].filter(Boolean).join(',')
  return secureUrl.replace('/upload/', `/upload/${transform}/`)
}

/** Delete an uploaded image from Cloudinary by its public id. */
export async function deleteImage(publicId: string): Promise<void> {
  await cloudinary.uploader.destroy(publicId)
}