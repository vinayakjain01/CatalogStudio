/**
 * Background Removal Service
 *
 * Central orchestration layer. Responsibilities:
 *  1. Check DB cache — return cached transparent PNG if exists
 *  2. If not cached, call the configured AI provider
 *  3. Upload the transparent PNG to Cloudinary for permanent storage
 *  4. Save the result to bg_removal_cache table
 *  5. Return the Cloudinary URL of the transparent PNG
 *
 * Provider is configurable via BG_REMOVAL_PROVIDER env var.
 * Default: 'cloudinary' (uses Cloudinary AI add-on)
 *
 * To switch providers, set BG_REMOVAL_PROVIDER=clipdrop (etc.) and
 * add the corresponding API key env var.
 */

import crypto from 'crypto'
import { v2 as cloudinary } from 'cloudinary'
import { SupabaseClient } from '@supabase/supabase-js'
import type { BackgroundRemovalProvider, ProviderName } from './provider'

cloudinary.config({
  cloud_name: process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
})

// ─── Provider factory ─────────────────────────────────────────────────────────

function getConfiguredProvider(): BackgroundRemovalProvider {
  const name = (process.env.BG_REMOVAL_PROVIDER || 'cloudinary') as ProviderName

  switch (name) {
    case 'clipdrop': {
      const { ClipdropBackgroundRemovalProvider } = require('./clipdrop-provider')
      return new ClipdropBackgroundRemovalProvider()
    }
    case 'cloudinary':
    default: {
      const { CloudinaryBackgroundRemovalProvider } = require('./cloudinary-provider')
      return new CloudinaryBackgroundRemovalProvider()
    }
  }
}

// ─── Cache key ────────────────────────────────────────────────────────────────

export function getCacheKey(imageUrl: string): string {
  return crypto.createHash('sha256').update(imageUrl).digest('hex')
}

// ─── Main service function ───────────────────────────────────────────────────

export interface BgRemovalResult {
  transparentUrl: string
  cloudinaryId: string
  fromCache: boolean
  provider: string
}

/**
 * Get the transparent PNG for a product image.
 * Checks cache first, calls AI provider if needed.
 * Never removes the same background twice.
 */
export async function getTransparentProductImage(
  sourceUrl: string,
  storeId: string,
  supabase: SupabaseClient
): Promise<BgRemovalResult> {
  const cacheKey = getCacheKey(sourceUrl)

  // 1. Check cache
  const { data: cached } = await supabase
    .from('bg_removal_cache')
    .select('transparent_url, cloudinary_id, provider')
    .eq('cache_key', cacheKey)
    .maybeSingle()

  if (cached) {
    console.log(`[bg-removal] Cache HIT for ${sourceUrl.slice(0, 60)}...`)
    return {
      transparentUrl: cached.transparent_url,
      cloudinaryId: cached.cloudinary_id,
      fromCache: true,
      provider: cached.provider,
    }
  }

  console.log(`[bg-removal] Cache MISS — calling AI provider for ${sourceUrl.slice(0, 60)}...`)

  // 2. Download the source image
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  let imageBuffer: Buffer
  try {
    const res = await fetch(sourceUrl, { signal: controller.signal })
    if (!res.ok) throw new Error(`Failed to fetch source image: ${res.status}`)
    imageBuffer = Buffer.from(await res.arrayBuffer())
  } finally {
    clearTimeout(timer)
  }

  // 3. Call provider
  const provider = getConfiguredProvider()
  const transparentBuffer = await provider.removeBackground(imageBuffer, sourceUrl)

  // 4. Upload transparent PNG to Cloudinary (permanent storage)
  const publicId = `transparent-products/${cacheKey.slice(0, 16)}`
  const cloudinaryResult = await new Promise<any>((resolve, reject) => {
    cloudinary.uploader.upload_stream(
      {
        public_id: publicId,
        folder: 'bg-removed',
        resource_type: 'image',
        overwrite: true,
        format: 'png', // must stay PNG for transparency
      },
      (error, result) => {
        if (error || !result) return reject(error || new Error('Cloudinary upload failed'))
        resolve(result)
      }
    ).end(transparentBuffer)
  })

  const transparentUrl = cloudinaryResult.secure_url
  const cloudinaryId = cloudinaryResult.public_id

  // 5. Save to cache (upsert in case of race condition)
  await supabase
    .from('bg_removal_cache')
    .upsert({
      cache_key: cacheKey,
      source_url: sourceUrl,
      transparent_url: transparentUrl,
      cloudinary_id: cloudinaryId,
      provider: provider.name,
      store_id: storeId,
    }, { onConflict: 'cache_key' })

  console.log(`[bg-removal] Done. Transparent PNG uploaded: ${transparentUrl}`)

  return {
    transparentUrl,
    cloudinaryId,
    fromCache: false,
    provider: provider.name,
  }
}

/**
 * Delete a cached entry (to force re-processing).
 */
export async function invalidateBgRemovalCache(
  sourceUrl: string,
  supabase: SupabaseClient
): Promise<void> {
  const cacheKey = getCacheKey(sourceUrl)
  const { data } = await supabase
    .from('bg_removal_cache')
    .select('cloudinary_id')
    .eq('cache_key', cacheKey)
    .maybeSingle()

  if (data?.cloudinary_id) {
    await cloudinary.uploader.destroy(data.cloudinary_id, { resource_type: 'image' }).catch(() => {})
  }

  await supabase
    .from('bg_removal_cache')
    .delete()
    .eq('cache_key', cacheKey)
}