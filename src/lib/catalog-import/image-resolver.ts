/**
 * Image URL Resolver + Downloader
 *
 * Line sheets can contain images from many sources:
 *  - Google Drive sharing links (drive.google.com/file/d/...)
 *  - Google Drive direct links (drive.google.com/uc?id=...)
 *  - Dropbox links (dropbox.com/s/...)
 *  - Shopify CDN (cdn.shopify.com)
 *  - Cloudinary (res.cloudinary.com)
 *  - Any public image URL
 *
 * This module normalizes URLs and downloads image buffers for Cloudinary upload.
 */

/**
 * Normalize a line-sheet image URL into a directly downloadable URL.
 * Handles Google Drive and Dropbox sharing links.
 */
export function normalizeImageUrl(url: string): string {
  if (!url || !url.trim()) return url

  const trimmed = url.trim()

  // Google Drive file sharing link:
  // https://drive.google.com/file/d/FILE_ID/view?usp=sharing
  // → https://drive.google.com/uc?export=download&id=FILE_ID
  const driveFileMatch = trimmed.match(
    /drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/
  )
  if (driveFileMatch) {
    return `https://drive.google.com/uc?export=download&id=${driveFileMatch[1]}`
  }

  // Google Drive open link:
  // https://drive.google.com/open?id=FILE_ID
  const driveOpenMatch = trimmed.match(
    /drive\.google\.com\/open\?id=([a-zA-Z0-9_-]+)/
  )
  if (driveOpenMatch) {
    return `https://drive.google.com/uc?export=download&id=${driveOpenMatch[1]}`
  }

  // Dropbox sharing link: dl=0 → dl=1
  if (trimmed.includes('dropbox.com') && trimmed.includes('dl=0')) {
    return trimmed.replace('dl=0', 'dl=1')
  }

  // Already a direct Dropbox download link
  if (trimmed.includes('dropbox.com') && !trimmed.includes('dl=')) {
    return `${trimmed}?dl=1`
  }

  // All other URLs: return as-is
  return trimmed
}

/**
 * Download an image from a URL and return as a Buffer.
 * Follows up to 3 redirects.
 * Times out after 20 seconds per attempt.
 */
export async function downloadImage(
  rawUrl: string,
  timeoutMs = 20_000
): Promise<{ buffer: Buffer; contentType: string }> {
  const url = normalizeImageUrl(rawUrl)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        // Some CDNs reject requests without a User-Agent
        'User-Agent': 'CatalogStudio/1.0 image-importer',
        'Accept': 'image/*,*/*',
      },
      redirect: 'follow',
    })

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} fetching ${url}`)
    }

    const contentType = res.headers.get('content-type') || 'image/jpeg'

    // Validate it's actually an image
    if (!contentType.startsWith('image/') && !contentType.startsWith('application/octet')) {
      // For Google Drive, content-type might be wrong — try anyway
      if (!url.includes('drive.google.com')) {
        throw new Error(`Not an image (content-type: ${contentType}) at ${url}`)
      }
    }

    const arrayBuffer = await res.arrayBuffer()
    if (arrayBuffer.byteLength < 100) {
      throw new Error(`Downloaded file too small (${arrayBuffer.byteLength} bytes) — may be a redirect page`)
    }

    return {
      buffer: Buffer.from(arrayBuffer),
      contentType,
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Upload a downloaded image buffer to Cloudinary.
 * Returns the Cloudinary secure_url.
 */
export async function uploadImageToCloudinary(
  buffer: Buffer,
  publicId: string
): Promise<{ url: string; cloudinaryId: string }> {
  const { v2: cloudinary } = await import('cloudinary')

  cloudinary.config({
    cloud_name: process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  })

  const result = await new Promise<any>((resolve, reject) => {
    cloudinary.uploader.upload_stream(
      {
        public_id: publicId,
        folder: 'catalog-imports',
        overwrite: false,      // skip if already uploaded
        resource_type: 'image',
        format: 'jpg',
        quality: 'auto:good',
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