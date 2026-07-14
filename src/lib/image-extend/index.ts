/**
 * AI Image Extend Service (Cloudinary Generative Fill)
 *
 * Takes a product image URL and a target canvas size, and returns a new
 * image URL where the original product is centered with AI-generated
 * background naturally filling the empty canvas regions.
 *
 * How Cloudinary Generative Fill works:
 *  1. Upload the source image to Cloudinary (if not already there)
 *  2. Request a transformation with c_pad + b_gen_fill at the target dimensions
 *  3. Cloudinary AI generates the missing background regions
 *  4. The original product pixels are NEVER modified
 *  5. Result is a fully filled image at exactly target_width × target_height
 *
 * Caching:
 *  Every source_url + width + height combination is cached forever in
 *  image_extend_cache. Re-generating the same product for the same template
 *  never costs an extra Cloudinary AI credit.
 *
 * Requires:
 *  - Cloudinary account with Generative Fill enabled
 *    (Cloudinary Media Library → Settings → Add-ons → Generative Fill)
 *  - All existing CLOUDINARY_* env vars (already configured)
 */

import crypto from 'crypto'
import { v2 as cloudinary } from 'cloudinary'
import type { SupabaseClient } from '@supabase/supabase-js'

cloudinary.config({
  cloud_name: process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
})

// ─── Cache key ────────────────────────────────────────────────────────────────

export function getExtendCacheKey(
  sourceUrl: string,
  targetWidth: number,
  targetHeight: number
): string {
  return crypto
    .createHash('sha256')
    .update(`${sourceUrl}|${targetWidth}|${targetHeight}|ai_extend|cloudinary`)
    .digest('hex')
}

// ─── Smart skip detection ─────────────────────────────────────────────────────
// Before calling the AI, calculate whether the image already fills the canvas.
// If the image's aspect ratio matches the canvas within 1%, skip the AI call.
// This prevents wasting credits on images that are already the right shape.

export function needsExtend(
  imageWidth: number,
  imageHeight: number,
  canvasWidth: number,
  canvasHeight: number
): boolean {
  if (!imageWidth || !imageHeight) return false
  const imageAr = imageWidth / imageHeight
  const canvasAr = canvasWidth / canvasHeight
  // Within 1% aspect ratio match means almost no empty space
  return Math.abs(imageAr - canvasAr) / canvasAr > 0.01
}

// ─── Upload source image to Cloudinary ───────────────────────────────────────
// If the product image is already a Cloudinary URL, we can derive the public_id
// directly and skip the upload. Otherwise, upload it first.

async function ensureOnCloudinary(sourceUrl: string): Promise<string> {
  // Already a Cloudinary URL — extract public_id from URL
  const cloudName = process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME
  if (sourceUrl.includes(`res.cloudinary.com/${cloudName}`)) {
    // Extract public_id: everything between /upload/[version/] and the extension
    const match = sourceUrl.match(/\/upload\/(?:v\d+\/)?(.+?)(?:\.[a-z]+)?$/)
    if (match) return match[1]
  }

  // Not on Cloudinary yet — upload it as a source image
  const result = await cloudinary.uploader.upload(sourceUrl, {
    folder: 'extend-sources',
    // Use a deterministic public_id based on the URL hash so we don't
    // upload the same source image twice across different extend calls
    public_id: `src_${crypto.createHash('sha256').update(sourceUrl).digest('hex').slice(0, 16)}`,
    overwrite: false,       // skip if already uploaded
    resource_type: 'image',
  })
  return result.public_id
}

// ─── Main extend function ─────────────────────────────────────────────────────

export interface ExtendResult {
  extendedUrl: string
  cloudinaryId: string
  fromCache: boolean
}

/**
 * Get the AI-extended version of a product image at the target canvas size.
 * Checks cache first — only calls Cloudinary AI if the combination is new.
 *
 * @param sourceUrl   Original product image URL (Shopify CDN or any public URL)
 * @param targetWidth  Canvas width in pixels (e.g. 1080)
 * @param targetHeight Canvas height in pixels (e.g. 1080)
 * @param storeId      For cache scoping (RLS)
 * @param supabase     Admin Supabase client
 */
export async function getExtendedImage(
  sourceUrl: string,
  targetWidth: number,
  targetHeight: number,
  storeId: string,
  supabase: SupabaseClient
): Promise<ExtendResult> {
  const cacheKey = getExtendCacheKey(sourceUrl, targetWidth, targetHeight)

  // 1. Check cache
  const { data: cached } = await supabase
    .from('image_extend_cache')
    .select('extended_url, cloudinary_id')
    .eq('cache_key', cacheKey)
    .maybeSingle()

  if (cached) {
    console.log(`[image-extend] Cache HIT ${targetWidth}x${targetHeight} for ${sourceUrl.slice(0, 60)}`)
    return {
      extendedUrl: cached.extended_url,
      cloudinaryId: cached.cloudinary_id,
      fromCache: true,
    }
  }

  console.log(`[image-extend] Cache MISS — running generative fill ${targetWidth}x${targetHeight} for ${sourceUrl.slice(0, 60)}`)

  // 2. Ensure source image is on Cloudinary
  const publicId = await ensureOnCloudinary(sourceUrl)

  // 3. Build the Cloudinary transformation URL with generative fill
  //
  // Transformation breakdown:
  //  w_{targetWidth},h_{targetHeight}  — target output dimensions
  //  c_pad                              — pad (letterbox) to target size using contain mode
  //  b_gen_fill                         — AI generative fill for the padded regions
  //  ar_{aspect_ratio_fraction}         — ensure correct aspect ratio computation
  //
  // Cloudinary processes this lazily on first URL access. The response is
  // cached on Cloudinary's CDN after the first generation.
  const transformedUrl = cloudinary.url(publicId, {
    width: targetWidth,
    height: targetHeight,
    crop: 'pad',
    background: 'gen_fill',
    fetch_format: 'png',
    quality: 'auto:best',
  })

  // 4. Trigger eager generation so we can download the buffer immediately
  //    (vs. waiting for the first URL access to trigger the transformation)
  const eagerPublicId = `extend-results/${cacheKey.slice(0, 24)}`

  let finalUrl: string
  let finalCloudinaryId: string

  try {
    // Upload with eager transformation to pre-generate the result
    const uploadResult = await cloudinary.uploader.upload(sourceUrl, {
      public_id: eagerPublicId,
      folder: 'extend-results',
      overwrite: true,
      resource_type: 'image',
      eager: [
        {
          width: targetWidth,
          height: targetHeight,
          crop: 'pad',
          background: 'gen_fill',
          fetch_format: 'auto',
          quality: 'auto:best',
        },
      ],
      eager_async: false, // Wait for eager transform to complete
    })

    // Use the eager transformation result URL
    const eagerResult = uploadResult.eager?.[0]
    if (eagerResult?.secure_url) {
      finalUrl = eagerResult.secure_url
      finalCloudinaryId = uploadResult.public_id
    } else {
      // Fallback: use the URL-based transformation (Cloudinary generates on first access)
      finalUrl = transformedUrl
      finalCloudinaryId = publicId
    }
  } catch (err: any) {
    console.error('[image-extend] Eager upload failed, falling back to URL transform:', err.message)
    // The URL-based approach still works — just triggers generation on first view
    finalUrl = transformedUrl
    finalCloudinaryId = publicId
  }

  // 5. Store in cache
  await supabase
    .from('image_extend_cache')
    .upsert({
      cache_key: cacheKey,
      source_url: sourceUrl,
      extended_url: finalUrl,
      cloudinary_id: finalCloudinaryId,
      width: targetWidth,
      height: targetHeight,
      fit_mode: 'ai_extend',
      provider: 'cloudinary',
      store_id: storeId,
    }, { onConflict: 'cache_key' })

  console.log(`[image-extend] Done. Extended image: ${finalUrl}`)

  return {
    extendedUrl: finalUrl,
    cloudinaryId: finalCloudinaryId,
    fromCache: false,
  }
}

/**
 * Invalidate a cached extend result (forces re-generation on next use).
 */
export async function invalidateExtendCache(
  sourceUrl: string,
  targetWidth: number,
  targetHeight: number,
  supabase: SupabaseClient
): Promise<void> {
  const cacheKey = getExtendCacheKey(sourceUrl, targetWidth, targetHeight)
  const { data } = await supabase
    .from('image_extend_cache')
    .select('cloudinary_id')
    .eq('cache_key', cacheKey)
    .maybeSingle()

  if (data?.cloudinary_id) {
    await cloudinary.uploader.destroy(data.cloudinary_id).catch(() => {})
  }

  await supabase
    .from('image_extend_cache')
    .delete()
    .eq('cache_key', cacheKey)
}
// ─── Positioned extend ────────────────────────────────────────────────────────
//
// Like getExtendedImage but places the SOURCE image at a specific position
// within the target canvas instead of centering it. Used by Product Zoom mode
// when head-space / bottom-space positioning moves the product to a non-center
// location, leaving canvas areas above/below/left/right that need AI fill.
//
// Cloudinary's c_pad always centers the source. To offset it we:
//  1. Pad the source image to a larger intermediate canvas that equals the
//     target canvas but with the source at the correct offset, using solid
//     background color for the intermediate padding.
//  2. Apply b_gen_fill to the intermediate to replace the solid padding with
//     AI-generated background that matches the image content.
//
// The cache key includes the offset so each position combo is cached separately.

export function getPositionedExtendCacheKey(
  sourceUrl: string,
  targetWidth: number,
  targetHeight: number,
  offsetX: number,
  offsetY: number,
  renderedW: number,
  renderedH: number
): string {
  return crypto
    .createHash('sha256')
    .update(`${sourceUrl}|${targetWidth}|${targetHeight}|${offsetX}|${offsetY}|${renderedW}|${renderedH}|positioned_extend_v1`)
    .digest('hex')
}

export interface PositionedExtendResult {
  extendedUrl: string
  cloudinaryId: string
  fromCache: boolean
}

/**
 * Extend a product image with AI-generated background so it fills the entire
 * target canvas, with the product placed at the given pixel offset.
 *
 * imgX/imgY/renderedW/renderedH are the 1× canvas coordinates of the product.
 * Values may be negative (product extends above/left of canvas).
 */
export async function getExtendedImagePositioned(
  sourceUrl: string,
  targetWidth: number,
  targetHeight: number,
  imgX: number,
  imgY: number,
  renderedW: number,
  renderedH: number,
  storeId: string,
  supabase: SupabaseClient
): Promise<PositionedExtendResult> {
  const cacheKey = getPositionedExtendCacheKey(
    sourceUrl, targetWidth, targetHeight,
    Math.round(imgX), Math.round(imgY),
    Math.round(renderedW), Math.round(renderedH)
  )

  // Check cache
  const { data: cached } = await supabase
    .from('image_extend_cache')
    .select('extended_url, cloudinary_id')
    .eq('cache_key', cacheKey)
    .maybeSingle()

  if (cached) {
    console.log(`[image-extend/positioned] Cache HIT ${targetWidth}x${targetHeight} offset=(${Math.round(imgX)},${Math.round(imgY)})`)
    return { extendedUrl: cached.extended_url, cloudinaryId: cached.cloudinary_id, fromCache: true }
  }

  console.log(`[image-extend/positioned] Cache MISS — ${targetWidth}x${targetHeight} offset=(${Math.round(imgX)},${Math.round(imgY)}) for ${sourceUrl.slice(0, 60)}`)

  const publicId = await ensureOnCloudinary(sourceUrl)

  // Cloudinary's c_pad centers the image. To place at offset (imgX, imgY)
  // we use x/y gravity offset with gravity=north_west.
  //
  // The source image will be scaled to renderedW×renderedH, then placed
  // at (imgX, imgY) within the target canvas, with b_gen_fill filling the rest.
  //
  // Cloudinary transformation:
  //  c_scale,w_{rW},h_{rH}           — scale source to rendered size
  //  c_pad,w_{targetW},h_{targetH},
  //    gravity=north_west,x_{ix},y_{iy},
  //    b_gen_fill                    — pad to canvas with AI fill, offset from top-left
  //
  // Negative offsets (image starts above/left of canvas): clamp to 0 since
  // Cloudinary can't place images before the canvas origin. In that case the
  // product extends to the edge naturally (canvas clips it).

  const clampedX = Math.max(0, Math.round(imgX))
  const clampedY = Math.max(0, Math.round(imgY))

  const eagerPublicId = `extend-results/pos_${cacheKey.slice(0, 24)}`
  let finalUrl: string
  let finalCloudinaryId: string

  try {
    const uploadResult = await cloudinary.uploader.upload(sourceUrl, {
      public_id: eagerPublicId,
      overwrite: true,
      resource_type: 'image',
      eager: [
        {
          transformation: [
            // Step 1: Scale the source image to rendered dimensions
            { width: Math.round(renderedW), height: Math.round(renderedH), crop: 'scale' },
            // Step 2: Pad out to the full target canvas, placing at offset from top-left
            // gravity: 'north_west' + x/y places the image at (x, y) from top-left corner
            {
              width: targetWidth,
              height: targetHeight,
              crop: 'pad' as any,
              background: 'gen_fill',
              gravity: 'north_west',
              x: clampedX,
              y: clampedY,
            },
          ],
          fetch_format: 'auto',
          quality: 'auto:best',
        },
      ],
      eager_async: false,
    })

    const eagerResult = uploadResult.eager?.[0]
    if (eagerResult?.secure_url) {
      finalUrl = eagerResult.secure_url
      finalCloudinaryId = uploadResult.public_id
    } else {
      // Fallback to URL-based transform
      finalUrl = cloudinary.url(publicId, {
        transformation: [
          { width: Math.round(renderedW), height: Math.round(renderedH), crop: 'scale' },
          { width: targetWidth, height: targetHeight, crop: 'pad', background: 'gen_fill',
            gravity: 'north_west', x: clampedX, y: clampedY } as any,
        ],
        fetch_format: 'png',
        quality: 'auto:best',
      })
      finalCloudinaryId = publicId
    }
  } catch (err: any) {
    console.error('[image-extend/positioned] Failed, falling back to centered extend:', err.message)
    // Fallback: use plain centered extend
    const fallback = await getExtendedImage(sourceUrl, targetWidth, targetHeight, storeId, supabase)
    return { ...fallback, fromCache: false }
  }

  // Store in cache
  await supabase
    .from('image_extend_cache')
    .upsert({
      cache_key: cacheKey,
      source_url: sourceUrl,
      extended_url: finalUrl,
      cloudinary_id: finalCloudinaryId,
      width: targetWidth,
      height: targetHeight,
      fit_mode: 'ai_extend',
      provider: 'cloudinary',
      store_id: storeId,
    }, { onConflict: 'cache_key' })

  console.log(`[image-extend/positioned] Done: ${finalUrl.slice(0, 80)}`)
  return { extendedUrl: finalUrl, cloudinaryId: finalCloudinaryId, fromCache: false }
}