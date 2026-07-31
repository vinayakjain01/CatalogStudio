/**
 * Catalog Image Storage
 *
 * Takes an image buffer that has already arrived on the server (browser folder
 * upload) and puts it into Cloudinary — the single storage backend for every
 * imported product image.
 *
 * Previously this module also resolved remote image URLs (Google Drive /
 * Dropbox sharing links) and downloaded the bytes itself. That source is gone:
 * images now arrive as multipart form-data from the user's own machine, so the
 * URL-normalisation and download layers were removed. The Cloudinary upload and
 * its compression policy are unchanged — the generation pipeline downstream
 * consumes exactly the same delivery URLs it always has.
 */

/**
 * Detect an image's real type from its magic bytes.
 *
 * Used for two things:
 *  - rejecting corrupt / mislabelled files (a .jpg that is really a PDF)
 *  - picking the right content type when the browser sends none
 *
 * Returns null when the bytes match no supported image format.
 */
export function detectImageType(buffer: Buffer): string | null {
  if (buffer.length < 12) return null

  // JPEG — FF D8
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg'

  // PNG — 89 50 4E 47
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png'
  }

  // GIF — 47 49 46
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'image/gif'

  // RIFF container — WEBP has "WEBP" at offset 8
  if (
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp'
  }

  // ISO-BMFF container — AVIF/HEIC declare their brand at offset 4 ("ftyp....")
  if (buffer.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buffer.toString('ascii', 8, 12)
    if (brand === 'avif' || brand === 'avis') return 'image/avif'
    if (brand === 'heic' || brand === 'heix' || brand === 'hevc') return 'image/heic'
  }

  return null
}

/**
 * Upload a downloaded image buffer to Cloudinary.
 *
 * Quality policy:
 *  - If the image fits under 9.8 MB: upload as-is (highest quality, no changes).
 *  - If the image is over 9.8 MB: re-encode as JPEG at the highest quality that
 *    still fits, using a progressive quality ladder (97→95→93→90→87→85→80→75).
 *    Last resort: resize to 75% of original dimensions at quality 90.
 *
 * WHY: Cloudinary's upload limit is 10 MB on the raw payload. The old approach
 * used an upload-time transformation (crop: 'limit') but that transform is applied
 * AFTER the bytes arrive — Cloudinary still rejects the upload if the payload itself
 * exceeds the limit, producing "File size too large. Got X. Maximum is 10485760."
 */
async function compressIfNeeded(buffer: Buffer): Promise<Buffer> {
  const MAX = 9.8 * 1024 * 1024
  if (buffer.length <= MAX) return buffer

  // Lazy-import @napi-rs/canvas — already a project dependency (serverExternalPackages)
  const { createCanvas, loadImage } = await import('@napi-rs/canvas')
  const img = await loadImage(buffer)

  for (const quality of [97, 95, 93, 90, 87, 85, 80, 75]) {
    const canvas = createCanvas(img.width, img.height)
    canvas.getContext('2d').drawImage(img, 0, 0)
    const out = (canvas as any).toBuffer('image/jpeg', { quality })
    if (out.length <= MAX) return out
  }

  // Last resort: scale to 75% then quality 90
  const w = Math.round(img.width  * 0.75)
  const h = Math.round(img.height * 0.75)
  const canvas = createCanvas(w, h)
  canvas.getContext('2d').drawImage(img, 0, 0, w, h)
  return (canvas as any).toBuffer('image/jpeg', { quality: 90 })
}

export async function uploadImageToCloudinary(
  rawBuffer: Buffer,
  publicId: string
): Promise<{ url: string; cloudinaryId: string }> {
  const { v2: cloudinary } = await import('cloudinary')

  cloudinary.config({
    cloud_name: process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  })

  // Compress before upload — Cloudinary rejects payloads > 10 MB at the
  // transport level, regardless of any upload-time transformations.
  const buffer = await compressIfNeeded(rawBuffer)

  const result = await new Promise<any>((resolve, reject) => {
    cloudinary.uploader.upload_stream(
      {
        public_id: publicId,
        folder: 'catalog-imports',
        overwrite: false,
        resource_type: 'image',
      },
      (error, result) => {
        if (error || !result) return reject(error || new Error('Upload failed'))
        resolve(result)
      }
    ).end(buffer)
  })

  return {
    url: result.secure_url,
    cloudinaryId: result.public_id,
  }
}

/**
 * Remove an image from Cloudinary. Best-effort — a failure here must never
 * block the database delete that follows it, otherwise a user can end up
 * unable to remove a product because of a storage hiccup.
 */
export async function deleteImageFromCloudinary(cloudinaryId: string): Promise<void> {
  const { v2: cloudinary } = await import('cloudinary')

  cloudinary.config({
    cloud_name: process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  })

  await cloudinary.uploader.destroy(cloudinaryId, { resource_type: 'image' })
}
