/**
 * Cloudinary AI Background Removal Adapter
 *
 * Uses Cloudinary's background_removal add-on (powered by Cloudinary AI).
 * This is the default provider since Cloudinary is already configured.
 *
 * How it works:
 * 1. Upload the source image to Cloudinary with bg_removal eager transform
 * 2. Poll until the background removal completes (async transformation)
 * 3. Download the resulting transparent PNG and return as Buffer
 *
 * Requires: Cloudinary account with AI Background Removal add-on enabled.
 * Enable at: cloudinary.com → Add-ons → AI Background Removal (free tier available)
 */

import { v2 as cloudinary } from 'cloudinary'
import type { BackgroundRemovalProvider } from './provider'

cloudinary.config({
  cloud_name: process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
})

const POLL_INTERVAL_MS = 2000
const POLL_MAX_ATTEMPTS = 30  // 60 seconds max

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}

async function downloadBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to download transparent image: ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

export class CloudinaryBackgroundRemovalProvider implements BackgroundRemovalProvider {
  readonly name = 'cloudinary'

  async removeBackground(imageBuffer: Buffer, sourceUrl?: string): Promise<Buffer> {
    // Upload with background_removal eager transformation
    const uploadResult = await new Promise<any>((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        {
          folder: 'bg-removal-tmp',
          resource_type: 'image',
          // Request eager async background removal
          eager: [{ background_removal: 'cloudinary_ai' }],
          eager_async: true,
          // Use source URL as public_id hint for caching
          ...(sourceUrl ? {
            public_id: `bg_tmp_${Buffer.from(sourceUrl).toString('base64').slice(0, 40).replace(/[^a-zA-Z0-9]/g, '_')}`,
            overwrite: false,
            invalidate: false,
          } : {}),
        },
        (error, result) => {
          if (error || !result) return reject(error || new Error('Upload failed'))
          resolve(result)
        }
      ).end(imageBuffer)
    })

    const publicId = uploadResult.public_id

    // If eager transformation already completed synchronously, use it
    if (uploadResult.eager?.[0]?.secure_url) {
      const buf = await downloadBuffer(uploadResult.eager[0].secure_url)
      // Clean up temp upload
      cloudinary.uploader.destroy(publicId, { resource_type: 'image' }).catch(() => {})
      return buf
    }

    // Poll for async completion
    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
      await sleep(POLL_INTERVAL_MS)

      const resource = await cloudinary.api.resource(publicId, {
        resource_type: 'image',
        eager: true,
      }).catch(() => null)

      const eager = resource?.eager?.[0]
      if (eager?.status === 'failed') {
        throw new Error('Cloudinary background removal failed')
      }

      if (eager?.secure_url) {
        const buf = await downloadBuffer(eager.secure_url)
        cloudinary.uploader.destroy(publicId, { resource_type: 'image' }).catch(() => {})
        return buf
      }
    }

    throw new Error('Cloudinary background removal timed out after 60s')
  }
}

/**
 * Alternative: Use Cloudinary URL-based transformation (no upload needed).
 * Pass the source URL directly and get a transformed URL back.
 * Faster but requires the image to be publicly accessible.
 */
export function getCloudinaryBgRemovalUrl(sourceUrl: string): string {
  // Encode the URL as a Cloudinary fetch URL with background removal
  const encoded = encodeURIComponent(sourceUrl)
  const cloudName = process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME
  return `https://res.cloudinary.com/${cloudName}/image/fetch/e_background_removal/${encoded}`
}