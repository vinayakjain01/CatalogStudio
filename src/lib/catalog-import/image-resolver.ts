/**
 * Image URL Resolver + Downloader
 *
 * Handles all the tricky image URL types found in real customer line sheets:
 *  - Google Drive sharing/view links  (most common issue)
 *  - Google Drive folder links
 *  - Dropbox links
 *  - Shopify CDN, Cloudinary, any public image URL
 *
 * Key fix: Google Drive `uc?export=download` redirects to an HTML virus-scan
 * warning page for files > ~100KB. We use the `/thumbnail` endpoint instead
 * which always returns the actual image bytes.
 */

/**
 * Normalize a line-sheet image URL into a directly downloadable URL.
 */
export function normalizeImageUrl(url: string): string {
  if (!url || !url.trim()) return url
  const trimmed = url.trim()

  // ── Google Drive: extract file ID from any Drive URL format ─────────────
  const driveId = extractGoogleDriveId(trimmed)
  if (driveId) {
    // Use the thumbnail endpoint — always returns actual image bytes
    // sz=s0 means "original size" (no downscaling)
    // This works for all shared Drive images without hitting the virus-scan page
    return `https://lh3.googleusercontent.com/d/${driveId}=s0`
  }

  // ── Dropbox ──────────────────────────────────────────────────────────────
  if (trimmed.includes('dropbox.com')) {
    // Convert sharing link to direct download
    return trimmed
      .replace('www.dropbox.com', 'dl.dropboxusercontent.com')
      .replace('?dl=0', '')
      .replace('&dl=0', '')
  }

  return trimmed
}

/**
 * Extract a Google Drive file ID from any Drive URL format.
 * Returns null if the URL is not a Drive URL.
 */
export function extractGoogleDriveId(url: string): string | null {
  // https://drive.google.com/file/d/FILE_ID/view
  const fileMatch = url.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/)
  if (fileMatch) return fileMatch[1]

  // https://drive.google.com/open?id=FILE_ID
  const openMatch = url.match(/drive\.google\.com\/open\?id=([a-zA-Z0-9_-]+)/)
  if (openMatch) return openMatch[1]

  // https://drive.google.com/uc?id=FILE_ID or uc?export=download&id=FILE_ID
  const ucMatch = url.match(/drive\.google\.com\/uc\?.*?id=([a-zA-Z0-9_-]+)/)
  if (ucMatch) return ucMatch[1]

  // https://drive.google.com/thumbnail?id=FILE_ID
  const thumbMatch = url.match(/drive\.google\.com\/thumbnail\?.*?id=([a-zA-Z0-9_-]+)/)
  if (thumbMatch) return thumbMatch[1]

  // https://lh3.googleusercontent.com/d/FILE_ID  (already normalized)
  const lhMatch = url.match(/lh3\.googleusercontent\.com\/d\/([a-zA-Z0-9_-]+)/)
  if (lhMatch) return lhMatch[1]

  return null
}

/**
 * Download an image from a URL and return as a Buffer.
 * Tries primary URL, then falls back to an alternate Google Drive URL if needed.
 */
export async function downloadImage(
  rawUrl: string,
  timeoutMs = 25_000
): Promise<{ buffer: Buffer; contentType: string }> {
  const normalized = normalizeImageUrl(rawUrl)

  // Try primary URL
  try {
    return await attemptDownload(normalized, timeoutMs)
  } catch (primaryErr: any) {
    // If this was a Drive URL, try fallback formats
    const driveId = extractGoogleDriveId(rawUrl)
    if (driveId && !normalized.includes('lh3.googleusercontent.com')) {
      // Fallback 1: lh3 thumbnail endpoint
      try {
        return await attemptDownload(
          `https://lh3.googleusercontent.com/d/${driveId}=s0`,
          timeoutMs
        )
      } catch { /* continue to fallback 2 */ }

      // Fallback 2: Drive direct content API endpoint
      try {
        return await attemptDownload(
          `https://drive.google.com/uc?export=view&id=${driveId}`,
          timeoutMs
        )
      } catch { /* all fallbacks failed */ }
    }

    throw primaryErr
  }
}

async function attemptDownload(
  url: string,
  timeoutMs: number
): Promise<{ buffer: Buffer; contentType: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CatalogStudio/1.0)',
        'Accept': 'image/*, */*;q=0.8',
      },
      redirect: 'follow',
    })

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} fetching ${url}`)
    }

    const contentType = res.headers.get('content-type') || ''

    // Detect HTML response (virus scan page, login redirect, etc.)
    if (
      contentType.includes('text/html') ||
      contentType.includes('text/plain')
    ) {
      // Peek at first bytes to confirm it's actually HTML
      const bytes = await res.arrayBuffer()
      const preview = Buffer.from(bytes).slice(0, 5).toString('ascii').toLowerCase()
      if (preview.startsWith('<!doc') || preview.startsWith('<html')) {
        throw new Error(
          'Got HTML instead of image — file may require Google sign-in or has sharing restrictions'
        )
      }
      // Might be a plain image with wrong content-type header — accept it
      const buf = Buffer.from(bytes)
      if (buf.length < 500) throw new Error(`Response too small (${buf.length} bytes)`)
      return { buffer: buf, contentType: 'image/jpeg' }
    }

    const arrayBuffer = await res.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)

    if (buffer.length < 500) {
      throw new Error(`Downloaded image too small (${buffer.length} bytes)`)
    }

    // Detect image type from magic bytes if content-type is wrong
    const finalContentType = detectImageType(buffer) || contentType || 'image/jpeg'

    return { buffer, contentType: finalContentType }
  } finally {
    clearTimeout(timer)
  }
}

function detectImageType(buffer: Buffer): string | null {
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) return 'image/jpeg'
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return 'image/png'
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'image/gif'
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) return 'image/webp'
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