import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas'
import path from 'path'
import { CanvasData, Layer, TextLayer, ImageLayer, RectangleLayer, BadgeLayer, BackgroundSettings, DEFAULT_BACKGROUND_SETTINGS, ProductLayerSettings, DEFAULT_PRODUCT_LAYER_SETTINGS } from '@/types/template'
import { resolveVariables } from '@/types/template'
import { mapWithConcurrency } from '@/lib/concurrency'
import { logPerf, measureAsync } from '@/lib/perf'

// ──────────────────────────────────────────────────────────────────────────
// QUALITY CONFIG
//
// `targetSize`        the final delivered pixel dimension (e.g. 1080).
// `SUPERSAMPLE`       internal render multiplier. We render larger, then let
//                     Cloudinary downscale on delivery. Supersampling is the
//                     single biggest quality win for text edges and thin shapes.
//
// We render a square canvas at targetSize * SUPERSAMPLE, draw everything in
// device pixels, and return a LOSSLESS PNG. All lossy compression happens
// exactly once, later, at Cloudinary delivery time — never here.
// ──────────────────────────────────────────────────────────────────────────

const DEFAULT_TARGET_SIZE = 1080
const SUPERSAMPLE = 2 // 2x is the sweet spot; 3x for print, at higher memory cost
const IMAGE_CACHE_TTL_MS = 10 * 60 * 1000
const IMAGE_CACHE_MAX = 250

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
  /** Final delivered dimension in px (square). Default 1080. */
  targetSize?: number
  /** Internal render multiplier. Default 2. */
  supersample?: number
  /** Template mode — 'standard' uses product image as-is; 'ai_product' floats transparent product over background */
  templateMode?: 'standard' | 'ai_product'
  /** Product layer settings for ai_product mode */
  productLayerSettings?: ProductLayerSettings
}

/**
 * Ensure we always pull Shopify's full-resolution master, never a resized
 * variant. Shopify encodes size into the filename as `_WIDTHxHEIGHT` right
 * before the extension (e.g. `shirt_800x800.jpg`). Stripping that suffix
 * yields the original upload. Non-Shopify URLs pass through untouched.
 */
function toFullResolution(src: string): string {
  try {
    return src.replace(/_(\d+)x(\d+)?(@\dx)?(\.\w+)(\?.*)?$/i, '$4$5')
  } catch {
    return src
  }
}

// Remote image loader with a hard timeout. @napi-rs/canvas's loadImage has no
// timeout, so a slow or unreachable product-image URL would hang the whole
// serverless function until it 504s. We fetch the bytes ourselves with an
// AbortController and hand the buffer to loadImage (which accepts Buffers).
async function loadImageUncached(src: string, timeoutMs = 12_000) {
  // data: URLs and local buffers pass straight through
  if (src.startsWith('data:')) return loadImage(src)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(src, { signal: controller.signal, cache: 'force-cache' })
    if (!res.ok) throw new Error(`image fetch ${res.status} for ${src}`)
    const buf = Buffer.from(await res.arrayBuffer())
    return await loadImage(buf)
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
    ctx.drawImage(img, x, y, w, h)
  }
}

export async function compositeImage(
  canvasData: CanvasData,
  product: ProductData,
  options: CompositeOptions = {}
): Promise<Buffer> {
  return measureAsync('creative.render.total', async () => {
    ensureFontsRegistered()

    const targetW = canvasData.width || 1080
    const targetH = canvasData.height || 1080

    // Render at SUPERSAMPLE× the target size, then downscale at the end.
    // This is the single biggest quality lever: it fixes soft/blurry edges
    // on the AI-removed product silhouette, anti-aliases text and shapes,
    // and matches how every professional design tool renders for export.
    const S = options.supersample ?? SUPERSAMPLE
    const W = targetW * S
    const H = targetH * S

    const canvas = createCanvas(W, H)
    const ctx = canvas.getContext('2d')
    // @napi-rs/canvas: ensure smooth scaling for any upscaled raster source
    if ('imageSmoothingEnabled' in ctx) ctx.imageSmoothingEnabled = true
    if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high'

    await measureAsync('creative.render.asset_preload', () =>
      preloadRenderableImages(canvasData, product),
      { layers: canvasData.layers.length }
    )

    // Background
    await serverRenderBackground(ctx, canvasData, product, W, H)

    const templateMode = options.templateMode || 'standard'
    const productLayerSettings = options.productLayerSettings || DEFAULT_PRODUCT_LAYER_SETTINGS

    if (templateMode === 'ai_product' && product.transparentImageUrl) {
      // AI Product Mode: split layers around the product layer zIndex
      const allLayers = [...canvasData.layers].sort((a, b) => a.zIndex - b.zIndex)
      const bgLayers = allLayers.filter(l => l.zIndex < productLayerSettings.zIndex)
      const fgLayers = allLayers.filter(l => l.zIndex >= productLayerSettings.zIndex)

      for (const layer of bgLayers) {
        await drawLayer(ctx, layer, product, W, H)
      }
      // Shadow/glow blur values are authored at 1x in the builder UI — scale
      // them up by S so they look identical at render resolution, then the
      // final downscale brings them back to the intended visual size.
      const scaledSettings: ProductLayerSettings = {
        ...productLayerSettings,
        shadowBlur: productLayerSettings.shadowBlur * S,
        shadowOffsetX: productLayerSettings.shadowOffsetX * S,
        shadowOffsetY: productLayerSettings.shadowOffsetY * S,
        glowBlur: productLayerSettings.glowBlur * S,
      }
      await drawProductLayer(ctx, product.transparentImageUrl, scaledSettings, W, H)
      for (const layer of fgLayers) {
        await drawLayer(ctx, layer, product, W, H)
      }
    } else {
      // Standard mode: draw all layers in z-order
      const sorted = [...canvasData.layers].sort((a, b) => a.zIndex - b.zIndex)
      for (const layer of sorted) {
        await drawLayer(ctx, layer, product, W, H)
      }
    }

    // Downscale from the supersampled render to the target size. This pass
    // is what removes jagged/soft edges — @napi-rs/canvas's drawImage does
    // a quality resample when scaling down, equivalent to a sharpen+AA pass.
    let finalCanvas = canvas
    if (S !== 1) {
      finalCanvas = createCanvas(targetW, targetH)
      const finalCtx = finalCanvas.getContext('2d')
      if ('imageSmoothingEnabled' in finalCtx) finalCtx.imageSmoothingEnabled = true
      if ('imageSmoothingQuality' in finalCtx) finalCtx.imageSmoothingQuality = 'high'
      finalCtx.drawImage(canvas as any, 0, 0, targetW, targetH)
    }

    const pngStarted = Date.now()
    const buffer = finalCanvas.toBuffer('image/png')
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
  H: number
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
        objectFit?: 'cover' | 'contain' | 'fill'
        borderRadius?: number
      }
      const imgSrc = l.src === '{{product_image}}' ? product.imageUrl : l.src
      const fit = l.objectFit || 'contain'
      const radius = l.borderRadius ?? 0
      if (imgSrc) {
        try {
          const img = await loadImageSafe(imgSrc)
          ctx.save()
          if (radius > 0) {
            roundRect(ctx, x, y, w, h, radius)
            ctx.clip()
          }
          drawFittedImage(ctx, img, x, y, w, h, fit as 'cover' | 'contain' | 'fill')
          ctx.restore()
        } catch (err: any) {
          console.error('[compositor] image load failed:', imgSrc, err?.message)
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