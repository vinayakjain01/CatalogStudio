import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas'
import path from 'path'
import {
  CanvasData, Layer, TextLayer, ImageLayer, RectangleLayer, BadgeLayer,
  BackgroundSettings, DEFAULT_BACKGROUND_SETTINGS,
  ProductLayerSettings, DEFAULT_PRODUCT_LAYER_SETTINGS,
} from '@/types/template'
import { resolveVariables } from '@/types/template'
import { mapWithConcurrency } from '@/lib/concurrency'
import { logPerf, measureAsync } from '@/lib/perf'
import { getExtendedImage, needsExtend } from '@/lib/image-extend'
import type { Canvas } from '@napi-rs/canvas'

// ──────────────────────────────────────────────────────────────────────────
// QUALITY CONFIG
//
// OUTPUT_SIZE        Final delivered pixel dimension on the longest side.
//                    2048 is the standard for premium catalog photography:
//                    it's print-ready, Retina-sharp on all screens, and
//                    still within Instagram/Meta upload specs.
//                    (Instagram: 1080–1440; Meta Ads: up to 1440×1800;
//                     Catalog print: 300dpi at ~7cm = 826px minimum)
//
// SUPERSAMPLE        Internal render multiplier. We render at OUTPUT_SIZE × S,
//                    then do a quality multi-step downscale to OUTPUT_SIZE.
//                    3× for 1080 output (3240 internal, 42MB).
//                    2× for 2048 output (4096 internal, 67MB) — same RAM budget,
//                    90% more output pixels, still clean downsampling from the
//                    full-resolution source (4160×6240 source → 1365px output
//                    means source is 3× larger than output = crisp detail).
//
// SUPERSAMPLE_LARGE  When template canvas > 1440px on any side, use 2× instead
//                    of 3× to stay within the ~75MB canvas RAM budget.
//
// PNG_COMPRESSION    0–9. Default (6) is slow and saves ~5% over level 1.
//                    Level 1 = lossless, 3× faster encode, imperceptibly larger.
//                    We upload lossless PNG once; Cloudinary delivers optimised
//                    WebP/AVIF from it, so storage size here is irrelevant.
// ──────────────────────────────────────────────────────────────────────────

const OUTPUT_SIZE      = 2048   // output px (square canvas; non-square uses canvasData dims)
const SUPERSAMPLE      = 2      // 2× for ≥ 1440px canvas  →  4096 internal, 67MB
const SUPERSAMPLE_SM   = 3      // 3× for < 1440px canvas  →  ≤ 4320 internal, 75MB
const PNG_COMPRESSION  = 1      // level 1: lossless, ~3× faster than default level 6
const IMAGE_CACHE_TTL_MS = 10 * 60 * 1000
const IMAGE_CACHE_MAX    = 250

/**
 * Choose supersample factor based on canvas dimensions.
 * Keeps internal canvas RAM under ~80MB on all plans.
 */
function chooseSuperSample(targetW: number, targetH: number, override?: number): number {
  if (override != null) return override
  const longest = Math.max(targetW, targetH)
  return longest >= 1440 ? SUPERSAMPLE : SUPERSAMPLE_SM
}

type CachedImage = {
  promise: Promise<any>
  expiresAt: number
}

const imageCache = new Map<string, CachedImage>()

// Register fonts once (module-level, runs on cold start)
let fontsRegistered = false
function ensureFontsRegistered() {
  if (fontsRegistered) return
  try {
    GlobalFonts.registerFromPath(
      path.join(process.cwd(), 'public/fonts/NotoSans-Regular.ttf'),
      'Inter'
    )
    GlobalFonts.registerFromPath(
      path.join(process.cwd(), 'public/fonts/NotoSans-Bold.ttf'),
      'Inter Bold'
    )
  } catch (err) {
    console.error('Font registration failed:', err)
  }
  fontsRegistered = true
}

interface ProductData {
  title: string
  price: number
  compare_at_price: number | null
  vendor: string | null
  product_type: string | null
  imageUrl: string | null
  /** Transparent PNG URL from background removal. Set when template is in ai_product mode. */
  transparentImageUrl?: string | null
}

export interface CompositeOptions {
  targetSize?: number
  supersample?: number
  templateMode?: 'standard' | 'ai_product'
  productLayerSettings?: ProductLayerSettings
  storeId?: string
  supabase?: any
}

/**
 * Upgrade a URL to its highest-quality version WITHOUT changing what content is shown.
 *
 * Three CDN patterns handled:
 *
 * 1. Cloudinary — strip non-content transforms between /upload/ and the version/path.
 *    Transforms like w_800,h_800,c_limit / f_auto,q_auto only resize/reformat.
 *    They do NOT change what part of the image is visible.
 *    Transforms like c_crop, c_fill, c_thumb DO change content → preserved unchanged.
 *
 * 2. Google Drive (lh3.googleusercontent.com) — ensure =s0 suffix (original size).
 *    =s1600 loads a 1600px thumbnail; =s0 loads the original full-res file.
 *
 * 3. Shopify CDN — strip _WxH size suffix before the extension.
 *    shirt_800x800.jpg → shirt.jpg (same image, original resolution).
 *
 * This gives us the real pixel data of the stored master, so supersampling at 3×
 * operates on the highest available quality and produces a sharper final output.
 */
function toHighQualityUrl(src: string): string {
  if (!src) return src

  try {
    // ── Cloudinary ──────────────────────────────────────────────────────────
    if (src.includes('res.cloudinary.com') && src.includes('/image/upload/')) {
      const uploadMarker = '/image/upload/'
      const uploadIdx = src.indexOf(uploadMarker)
      const afterUpload = src.slice(uploadIdx + uploadMarker.length)
      const firstSeg = afterUpload.split('/')[0]

      // If the first segment is already a version number (v1234), no transforms present
      if (/^v\d+$/.test(firstSeg)) return src

      // Content-altering crop transforms — changing these would show a different image
      const contentCrops = ['c_crop', 'c_fill', 'c_thumb', 'c_lfill', 'c_imagga_crop', 'c_auto', 'c_pad']
      const hasContentCrop = contentCrops.some(c => firstSeg.includes(c))
      if (hasContentCrop) return src  // Preserve — these define what content is visible

      // Strip the transforms segment (only quality/size/format — safe to remove)
      const rest = afterUpload.slice(firstSeg.length + 1)  // +1 for the slash
      return src.slice(0, uploadIdx + uploadMarker.length) + rest
    }

    // ── Google Drive (lh3.googleusercontent.com) ────────────────────────────
    if (src.includes('lh3.googleusercontent.com/d/')) {
      // Replace any =sNNNN size param with =s0 (original size)
      const base = src.replace(/=s\d+[^&]*/, '')
      return base.endsWith('=s0') ? base : base + '=s0'
    }

    // ── Shopify CDN ─────────────────────────────────────────────────────────
    if (src.includes('cdn.shopify.com')) {
      // Strip _WxH or _Wx or _xH size suffixes before the file extension
      return src.replace(
        /(_(\d+x\d*|\d*x\d+)(@\dx)?)(\.(jpg|jpeg|png|webp|gif))(\?.*)?$/i,
        '$4$6'
      )
    }
  } catch {
    // URL parsing failed — return original unchanged
  }

  return src
}

/**
 * Load an image at its highest quality.
 * Always fetches the full-resolution master by calling toHighQualityUrl first.
 * Falls back to the original URL if the high-quality URL fails.
 */
async function loadImageUncached(src: string, timeoutMs = 20_000) {
  if (src.startsWith('data:')) return loadImage(src)

  const highQualitySrc = toHighQualityUrl(src)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(highQualitySrc, { signal: controller.signal, cache: 'force-cache' })
    if (!res.ok) {
      // If we modified the URL and it failed, fall back to original
      if (highQualitySrc !== src) {
        const fallback = await fetch(src, { signal: new AbortController().signal, cache: 'force-cache' })
        if (!fallback.ok) throw new Error(`image fetch ${res.status} for ${src}`)
        return await loadImage(Buffer.from(await fallback.arrayBuffer()))
      }
      throw new Error(`image fetch ${res.status} for ${src}`)
    }
    return await loadImage(Buffer.from(await res.arrayBuffer()))
  } finally {
    clearTimeout(timer)
  }
}

async function loadImageSafe(src: string, timeoutMs = 12_000) {
  if (src.startsWith('data:')) return loadImageUncached(src, timeoutMs)

  const now = Date.now()
  const cached = imageCache.get(src)
  if (cached && cached.expiresAt > now) return cached.promise

  const promise = loadImageUncached(src, timeoutMs).catch(err => {
    imageCache.delete(src)
    throw err
  })

  imageCache.set(src, { promise, expiresAt: now + IMAGE_CACHE_TTL_MS })
  pruneImageCache(now)
  return promise
}

function pruneImageCache(now = Date.now()) {
  for (const [key, value] of imageCache) {
    if (value.expiresAt <= now) imageCache.delete(key)
  }

  while (imageCache.size > IMAGE_CACHE_MAX) {
    const firstKey = imageCache.keys().next().value as string | undefined
    if (!firstKey) break
    imageCache.delete(firstKey)
  }
}

async function preloadRenderableImages(canvasData: CanvasData, product: { imageUrl: string | null }) {
  const urls = new Set<string>()
  const settings: BackgroundSettings = canvasData.backgroundSettings ?? DEFAULT_BACKGROUND_SETTINGS

  if (settings.mode === 'solid' && canvasData.backgroundImageUrl) {
    urls.add(canvasData.backgroundImageUrl)
  }
  if (settings.mode !== 'solid' && settings.mode !== 'transparent' && product.imageUrl) {
    urls.add(product.imageUrl)
  }

  for (const layer of canvasData.layers) {
    if (!['overlay', 'logo', 'sticker', 'image'].includes(layer.type)) continue
    const imageLayer = layer as Layer & { src?: string }
    const src = imageLayer.src === '{{product_image}}' ? product.imageUrl : imageLayer.src
    if (src) urls.add(src)
  }

  await mapWithConcurrency([...urls], 6, async src => {
    try {
      await loadImageSafe(src)
    } catch {
      // The draw path keeps the existing per-layer fallback behavior.
    }
  })
}

// ─── Server-side background renderers ────────────────────────────────────────
// Mirror of the client-side logic in smart-background.tsx, implemented with
// @napi-rs/canvas so it works in the compositor (Node.js / serverless).

interface RgbColor { r: number; g: number; b: number }

function serverExtractDominantColors(
  ctx: any, // napi CanvasRenderingContext2D
  imgNode: any, // napi Image
  count = 2
): RgbColor[] {
  const size = 64
  const tmp = createCanvas(size, size)
  const tctx = tmp.getContext('2d')
  tctx.drawImage(imgNode, 0, 0, size, size)
  const data: Uint8ClampedArray = tctx.getImageData(0, 0, size, size).data

  const buckets: Record<string, { r: number; g: number; b: number; count: number }> = {}
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]
    if (a < 64) continue
    const r = data[i] >> 4
    const g = data[i + 1] >> 4
    const b = data[i + 2] >> 4
    const key = `${r},${g},${b}`
    if (!buckets[key]) buckets[key] = { r: r << 4, g: g << 4, b: b << 4, count: 0 }
    buckets[key].count++
  }
  return Object.values(buckets)
    .sort((a, b) => b.count - a.count)
    .slice(0, count)
    .map(({ r, g, b }) => ({ r, g, b }))
}

function rgbToHex({ r, g, b }: RgbColor) {
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')
}

function serverRenderBlurExtend(
  ctx: any,
  imgNode: any,
  W: number,
  H: number,
  blurStrength: number
) {
  // @napi-rs/canvas supports ctx.filter
  const scale = Math.max(W / imgNode.width, H / imgNode.height) * 1.15
  const sw = imgNode.width * scale
  const sh = imgNode.height * scale
  const sx = (W - sw) / 2
  const sy = (H - sh) / 2
  ctx.save()
  ctx.filter = `blur(${blurStrength}px) saturate(1.2) brightness(0.9)`
  ctx.drawImage(imgNode, sx, sy, sw, sh)
  ctx.filter = 'none'
  ctx.restore()
}

async function serverRenderBackground(
  ctx: any,
  canvasData: CanvasData,
  product: { imageUrl: string | null },
  W: number,
  H: number
): Promise<void> {
  const settings: BackgroundSettings = canvasData.backgroundSettings ?? DEFAULT_BACKGROUND_SETTINGS

  // Always fill solid color first
  ctx.fillStyle = canvasData.backgroundColor
  ctx.fillRect(0, 0, W, H)

  if (settings.mode === 'solid') {
    // existing backgroundImageUrl passthrough
    if (canvasData.backgroundImageUrl) {
      try {
        const bgImg = await loadImageSafe(canvasData.backgroundImageUrl)
        ctx.drawImage(bgImg, 0, 0, W, H)
      } catch {}
    }
    return
  }

  if (settings.mode === 'transparent') {
    // Fill with transparent (already done by clearing; compositor keeps it)
    ctx.clearRect(0, 0, W, H)
    return
  }

  // For smart / blur-extend / gradient — load the product image as the source
  const imgSrc = product.imageUrl
  let imgNode: any = null
  if (imgSrc) {
    try { imgNode = await loadImageSafe(imgSrc) } catch {}
  }

  switch (settings.mode) {
    case 'blur-extend': {
      if (imgNode) serverRenderBlurExtend(ctx, imgNode, W, H, settings.blurStrength)
      break
    }
    case 'smart': {
      if (imgNode) {
        serverRenderBlurExtend(ctx, imgNode, W, H, settings.blurStrength)
        // Radial blend overlay
        const colors = serverExtractDominantColors(ctx, imgNode, 2)
        if (colors.length > 0) {
          const { r, g, b } = colors[0]
          const radial = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.7)
          radial.addColorStop(0, `rgba(${r},${g},${b},0)`)
          radial.addColorStop(1, `rgba(${r},${g},${b},${settings.blendStrength * 0.5})`)
          ctx.fillStyle = radial
          ctx.fillRect(0, 0, W, H)
        }
      }
      break
    }
    case 'gradient': {
      let stops = settings.gradientStops
      if (settings.autoColors && imgNode) {
        const colors = serverExtractDominantColors(ctx, imgNode, 2)
        if (colors.length >= 2) {
          stops = [
            { color: rgbToHex(colors[0]), position: 0 },
            { color: rgbToHex(colors[1]), position: 100 },
          ]
        } else if (colors.length === 1) {
          const { r, g, b } = colors[0]
          const lighter = `#${[r, g, b].map(v => Math.min(255, v + 60).toString(16).padStart(2, '0')).join('')}`
          stops = [
            { color: rgbToHex(colors[0]), position: 0 },
            { color: lighter, position: 100 },
          ]
        }
      }
      const angleRad = (settings.gradientAngle * Math.PI) / 180
      const dx = Math.cos(angleRad)
      const dy = Math.sin(angleRad)
      const len = Math.sqrt(W * W + H * H)
      const cx = W / 2, cy = H / 2
      const grad = ctx.createLinearGradient(
        cx - (dx * len) / 2, cy - (dy * len) / 2,
        cx + (dx * len) / 2, cy + (dy * len) / 2
      )
      for (const s of stops) grad.addColorStop(s.position / 100, s.color)
      ctx.fillStyle = grad
      ctx.fillRect(0, 0, W, H)
      break
    }
  }
}

// ─── AI Product Layer Renderer ───────────────────────────────────────────────
// Draws the transparent product PNG as a floating layer with effects.

async function drawProductLayer(
  ctx: any,
  transparentImageUrl: string,
  settings: ProductLayerSettings,
  W: number,
  H: number
): Promise<void> {
  const img = await loadImageSafe(transparentImageUrl)

  const pad = (settings.padding / 100)
  const x = ((settings.x / 100) + pad / 2) * W
  const y = ((settings.y / 100) + pad / 2) * H
  const w = ((settings.width / 100) - pad) * W
  const h = ((settings.height / 100) - pad) * H

  ctx.save()
  ctx.globalAlpha = settings.opacity

  // Apply rotation around center
  if (settings.rotation !== 0) {
    ctx.translate(x + w / 2, y + h / 2)
    ctx.rotate((settings.rotation * Math.PI) / 180)
    ctx.translate(-(x + w / 2), -(y + h / 2))
  }

  // Drop shadow
  if (settings.shadow) {
    ctx.shadowColor = settings.shadowColor
    ctx.shadowBlur = settings.shadowBlur
    ctx.shadowOffsetX = settings.shadowOffsetX
    ctx.shadowOffsetY = settings.shadowOffsetY
  }

  // Glow (rendered as extra blurred layer beneath)
  if (settings.glow) {
    ctx.save()
    ctx.shadowColor = settings.glowColor
    ctx.shadowBlur = settings.glowBlur
    ctx.shadowOffsetX = 0
    ctx.shadowOffsetY = 0
    const fit = settings.objectFit || 'contain'
    drawFittedImage(ctx, img, x, y, w, h, fit)
    ctx.restore()
  }

  // Draw the actual transparent product image
  const fit = settings.objectFit || 'contain'
  drawFittedImage(ctx, img, x, y, w, h, fit)

  ctx.restore()
}

function drawFittedImage(
  ctx: any,
  img: any,
  x: number, y: number,
  w: number, h: number,
  fit: 'contain' | 'cover' | 'fill'
) {
  if (fit === 'cover') {
    const scale = Math.max(w / img.width, h / img.height)
    const sw = img.width * scale
    const sh = img.height * scale
    ctx.drawImage(img, x + (w - sw) / 2, y + (h - sh) / 2, sw, sh)
  } else if (fit === 'contain') {
    const scale = Math.min(w / img.width, h / img.height)
    const sw = img.width * scale
    const sh = img.height * scale
    ctx.drawImage(img, x + (w - sw) / 2, y + (h - sh) / 2, sw, sh)
  } else {
    // 'fill' — draw at exactly the given x/y/w/h coordinates.
    // Head-space placement pre-calculates these so the image fits inside the
    // canvas exactly. We draw using the full source image (sx=0,sy=0,sw=img.width,
    // sh=img.height) mapped to the destination rect.
    //
    // No clip needed — the caller handles borderRadius clipping before this call.
    ctx.drawImage(img, 0, 0, img.width, img.height, x, y, w, h)
  }
}

// ─── Head Space AI Extend Integration ────────────────────────────────────────
//
// When Smart Auto Zoom causes the product to overflow the canvas, we call
// getExtendedImage with an EXPANDED source-image so the AI can fill the gap.
//
// Strategy:
//   1. Detect overflow from the calculated placement.
//   2. Compute required canvas expansion (computeExtendedCanvasDimensions).
//   3. Call getExtendedImage with the expanded dimensions.
//   4. Draw the extended image, then overlay the product at the correct
//      position (adjusted for the canvas offset).
//
// This is different from the existing ai_extend objectFit mode, which
// extends the original image to fit the template canvas. Here we are
// extending the canvas ITSELF to accommodate a zoomed product, then
// compositing both the extended background and the sharp product on top.

// ─── Main Composite Function ──────────────────────────────────────────────────

export async function compositeImage(
  canvasData: CanvasData,
  product: ProductData,
  options: CompositeOptions = {}
): Promise<Buffer> {
  return measureAsync('creative.render.total', async () => {
    ensureFontsRegistered()

    // ── Output dimensions ────────────────────────────────────────────────────
    // Use the template's canvas size if it's larger than OUTPUT_SIZE.
    // Otherwise scale up to OUTPUT_SIZE while preserving the aspect ratio.
    // This means a 1080×1080 template outputs at 2048×2048 (90% more pixels),
    // while a 1080×1350 template outputs at 1638×2048 (preserves 4:5 ratio).
    // No zoom, no crop — just more pixels of the same image.
    const rawW = canvasData.width  || 1080
    const rawH = canvasData.height || 1080

    let targetW: number
    let targetH: number

    if (rawW >= OUTPUT_SIZE || rawH >= OUTPUT_SIZE) {
      // Template is already large — use as-is
      targetW = rawW
      targetH = rawH
    } else {
      // Scale up to OUTPUT_SIZE on the longest side, preserving aspect ratio
      const upScale = OUTPUT_SIZE / Math.max(rawW, rawH)
      // Round to even numbers (better for video encoding and Cloudinary processing)
      targetW = Math.round(rawW * upScale / 2) * 2
      targetH = Math.round(rawH * upScale / 2) * 2
    }

    // ── Supersampling ─────────────────────────────────────────────────────────
    // Internal canvas is targetW×targetH × S. Render at high res, downscale at end.
    // chooseSuperSample keeps internal canvas RAM under ~80MB across all plan tiers.
    const S = chooseSuperSample(targetW, targetH, options.supersample)
    const W = targetW * S
    const H = targetH * S

    console.log(
      `[compositor] render ${rawW}×${rawH} template → ${targetW}×${targetH} output ` +
      `(SS=${S}, internal=${W}×${H}, RAM≈${Math.round(W*H*4/1e6)}MB)`
    )

    const canvas = createCanvas(W, H)
    const ctx = canvas.getContext('2d')
    if ('imageSmoothingEnabled' in ctx) ctx.imageSmoothingEnabled = true
    if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high'

    await measureAsync('creative.render.asset_preload', () =>
      preloadRenderableImages(canvasData, product),
      { layers: canvasData.layers.length }
    )

    // Background
    await serverRenderBackground(ctx, canvasData, product, W, H)

    const templateMode = options.templateMode || 'standard'
    let productLayerSettings = options.productLayerSettings || DEFAULT_PRODUCT_LAYER_SETTINGS

    // Layer-drawing options passed to every drawLayer call
    const layerOpts = {
      storeId: options.storeId,
      supabase: options.supabase,
      targetW,
      targetH,
    }

    if (templateMode === 'ai_product' && product.transparentImageUrl) {
      const allLayers = [...canvasData.layers].sort((a, b) => a.zIndex - b.zIndex)
      const bgLayers = allLayers.filter(l => l.zIndex < productLayerSettings.zIndex)
      const fgLayers = allLayers.filter(l => l.zIndex >= productLayerSettings.zIndex)

      for (const layer of bgLayers) {
        await drawLayer(ctx, layer, product, W, H, layerOpts)
      }
      const scaledSettings: ProductLayerSettings = {
        ...productLayerSettings,
        shadowBlur:    productLayerSettings.shadowBlur    * S,
        shadowOffsetX: productLayerSettings.shadowOffsetX * S,
        shadowOffsetY: productLayerSettings.shadowOffsetY * S,
        glowBlur:      productLayerSettings.glowBlur      * S,
      }
      await drawProductLayer(ctx, product.transparentImageUrl, scaledSettings, W, H)
      for (const layer of fgLayers) {
        await drawLayer(ctx, layer, product, W, H, layerOpts)
      }
    } else {
      const sorted = [...canvasData.layers].sort((a, b) => a.zIndex - b.zIndex)
      for (const layer of sorted) {
        await drawLayer(ctx, layer, product, W, H, layerOpts)
      }
    }

    // ── Multi-step quality downscale ─────────────────────────────────────────
    // Single-step downscale from 3× to 1× can produce softness at edges.
    // Multi-step halving (Mitchell/Lanczos-equivalent) preserves sharpness:
    //   3240 → 1620 → 1080  (two 2× steps instead of one 3× step)
    //   4096 → 2048         (one clean 2× step — optimal for SS=2)
    //   4320 → 2160 → 1080  (two steps for SS=3 + small canvas)
    // Each halving is a perfect power-of-2 scale — maximum quality for that step.
    let finalCanvas: Canvas

    if (S === 1) {
      finalCanvas = canvas
    } else {
      // Build the downscale chain: halve until we reach target size
      let currentCanvas = canvas
      let currentW = W
      let currentH = H

      while (currentW > targetW * 1.5 || currentH > targetH * 1.5) {
        // Halve each step (but never go below target)
        const nextW = Math.max(targetW, Math.round(currentW / 2))
        const nextH = Math.max(targetH, Math.round(currentH / 2))
        const stepCanvas = createCanvas(nextW, nextH)
        const stepCtx = stepCanvas.getContext('2d')
        if ('imageSmoothingEnabled' in stepCtx) stepCtx.imageSmoothingEnabled = true
        if ('imageSmoothingQuality' in stepCtx) stepCtx.imageSmoothingQuality = 'high'
        stepCtx.drawImage(currentCanvas as any, 0, 0, nextW, nextH)
        currentCanvas = stepCanvas
        currentW = nextW
        currentH = nextH
      }

      // Final step to exact target dimensions
      if (currentW !== targetW || currentH !== targetH) {
        finalCanvas = createCanvas(targetW, targetH)
        const finalCtx = finalCanvas.getContext('2d')
        if ('imageSmoothingEnabled' in finalCtx) finalCtx.imageSmoothingEnabled = true
        if ('imageSmoothingQuality' in finalCtx) finalCtx.imageSmoothingQuality = 'high'
        finalCtx.drawImage(currentCanvas as any, 0, 0, targetW, targetH)
      } else {
        finalCanvas = currentCanvas
      }
    }

    // ── PNG encode ────────────────────────────────────────────────────────────
    // compressionLevel 1 = lossless (same pixel data as level 6),
    // ~3× faster encode, imperceptibly larger file.
    // We upload lossless once; Cloudinary delivers optimised WebP/AVIF.
    const pngStarted = Date.now()
    const buffer = (finalCanvas as any).toBuffer('image/png', { compressionLevel: PNG_COMPRESSION })
    logPerf('creative.render.png_encode', Date.now() - pngStarted, {
      bytes: buffer.length,
      width: targetW,
      height: targetH,
      supersample: S,
    })
    return buffer
  }, { layers: canvasData.layers.length })
}

/** Draw a single layer onto the canvas context. Extracted for reuse in both modes. */
async function drawLayer(
  ctx: any,
  layer: Layer,
  product: ProductData,
  W: number,
  H: number,
  options?: {
    storeId?: string
    supabase?: any
    targetW?: number
    targetH?: number
  }
): Promise<void> {
  const x = (layer.x / 100) * W
  const y = (layer.y / 100) * H
  const w = (layer.width / 100) * W
  const h = (layer.height / 100) * H

  ctx.save()
  ctx.globalAlpha = layer.opacity

  if (layer.rotation !== 0) {
    ctx.translate(x + w / 2, y + h / 2)
    ctx.rotate((layer.rotation * Math.PI) / 180)
    ctx.translate(-(x + w / 2), -(y + h / 2))
  }

  switch (layer.type) {
    case 'rectangle': {
      const l = layer as RectangleLayer
      ctx.fillStyle = l.backgroundColor
      roundRect(ctx, x, y, w, h, l.borderRadius)
      ctx.fill()
      if (l.borderWidth > 0) {
        ctx.strokeStyle = l.borderColor
        ctx.lineWidth = l.borderWidth
        roundRect(ctx, x, y, w, h, l.borderRadius)
        ctx.stroke()
      }
      break
    }

    case 'text': {
      const l = layer as TextLayer
      const text = resolveVariables(l.content, product)
      const family = l.fontWeight === 'bold' ? 'Inter Bold' : 'Inter'
      const scaledFontSize = l.fontSize * (W / 1000)
      ctx.font = `${scaledFontSize}px "${family}"`
      ctx.fillStyle = l.color
      ctx.textBaseline = 'top'
      ctx.textAlign = l.textAlign as CanvasTextAlign

      if (l.backgroundColor) {
        ctx.fillStyle = l.backgroundColor
        roundRect(ctx, x, y, w, h, l.borderRadius)
        ctx.fill()
        ctx.fillStyle = l.color
      }

      const paddingX = l.paddingX * (W / 1000)
      const paddingY = l.paddingY * (H / 1000)
      const textX = l.textAlign === 'center'
        ? x + w / 2
        : l.textAlign === 'right'
          ? x + w - paddingX
          : x + paddingX
      ctx.fillText(text, textX, y + paddingY, w - paddingX * 2)
      break
    }

    case 'badge': {
      const l = layer as BadgeLayer
      const text = resolveVariables(l.content, product)
      const radius = l.shape === 'circle' ? Math.min(w, h) / 2 : l.borderRadius
      ctx.fillStyle = l.backgroundColor
      if (l.shape === 'circle') {
        ctx.beginPath()
        ctx.arc(x + w / 2, y + h / 2, Math.min(w, h) / 2, 0, Math.PI * 2)
        ctx.fill()
      } else {
        roundRect(ctx, x, y, w, h, radius)
        ctx.fill()
      }
      ctx.fillStyle = l.color
      const family = l.fontWeight === 'bold' ? 'Inter Bold' : 'Inter'
      ctx.font = `${l.fontSize * (W / 1000)}px "${family}"`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(text, x + w / 2, y + h / 2, w)
      break
    }

    case 'overlay':
    case 'logo':
    case 'sticker':
    case 'image': {
      const l = layer as Layer & {
        src: string
        objectFit?: 'cover' | 'contain' | 'fill' | 'ai_extend'
        borderRadius?: number
      }
      const imgSrc = l.src === '{{product_image}}' ? product.imageUrl : l.src
      const fit = l.objectFit || 'contain'
      const radius = (l as any).borderRadius ?? 0

      if (imgSrc) {
        // ── AI Extend: use Cloudinary Generative Fill ──────────────────────
        // When objectFit='ai_extend' and we have a product image layer,
        // the extend service returns an already-full-canvas image so we
        // draw it cover-style (should fill exactly with no empty space).
        let resolvedSrc = imgSrc
        if (fit === 'ai_extend' && l.src === '{{product_image}}' && options?.storeId && options?.supabase) {
          const targetW = options.targetW ?? W
          const targetH = options.targetH ?? H
          // Check if extend is actually needed (skip if image already fills canvas)
          const imgForCheck = await loadImageSafe(imgSrc).catch(() => null)
          const actualNeedsExtend = imgForCheck
            ? needsExtend(imgForCheck.width, imgForCheck.height, targetW, targetH)
            : true

          if (actualNeedsExtend) {
            try {
              const extendResult = await getExtendedImage(
                imgSrc,
                targetW,
                targetH,
                options.storeId,
                options.supabase
              )
              resolvedSrc = extendResult.extendedUrl
              console.log(`[compositor] AI extend ${extendResult.fromCache ? 'cached' : 'fresh'} for ${imgSrc.slice(0, 50)}`)
            } catch (extErr: any) {
              console.error('[compositor] AI extend failed, falling back to contain:', extErr.message)
              // Graceful fallback: show image with contain (no empty black bars,
              // just letterbox) rather than breaking the whole creative
            }
          }
        }

        try {
          const img = await loadImageSafe(resolvedSrc)
          ctx.save()
          if (radius > 0) {
            roundRect(ctx, x, y, w, h, radius)
            ctx.clip()
          }
          // ai_extend result already fills exactly, so draw it as 'cover'
          const drawFit = fit === 'ai_extend' ? 'cover' : fit as 'cover' | 'contain' | 'fill'
          drawFittedImage(ctx, img, x, y, w, h, drawFit)
          ctx.restore()
        } catch (err: any) {
          console.error('[compositor] image load failed:', resolvedSrc, err?.message)
          if (layer.type === 'image') {
            ctx.fillStyle = '#dddddd'
            roundRect(ctx, x, y, w, h, radius)
            ctx.fill()
          }
        }
      }
      break
    }
  }

  ctx.restore()
}

function roundRect(
  ctx: any,
  x: number, y: number,
  w: number, h: number,
  r: number
) {
  r = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}