import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas'
import path from 'path'
import {
  CanvasData, Layer, TextLayer, ImageLayer, RectangleLayer, BadgeLayer,
  BackgroundSettings, DEFAULT_BACKGROUND_SETTINGS,
  ProductLayerSettings, DEFAULT_PRODUCT_LAYER_SETTINGS,
  ProductPositioningSettings,
} from '@/types/template'
import { resolveVariables } from '@/types/template'
import { mapWithConcurrency } from '@/lib/concurrency'
import { logPerf, measureAsync } from '@/lib/perf'
import { getExtendedImage, getExtendedImagePositioned, needsExtend } from '@/lib/image-extend'
import {
  resolveProductPositioning,
  classifyProductImage,
  classifyProductZoomImage,
  type ClassifyResult,
} from '@/lib/product-positioning'
import {
  placementToProductLayerSettings,
  calculatePlacement,
  calculateSmartFitPlacement,
  type ProductBounds,
} from '@/lib/product-positioning-shared'
import type { CompositorBundle } from '@/types/product-layer'
import type { Canvas } from '@napi-rs/canvas'

// ──────────────────────────────────────────────────────────────────────────
// QUALITY CONFIG — unchanged from original
// ──────────────────────────────────────────────────────────────────────────

const OUTPUT_SIZE      = 2048
const SUPERSAMPLE      = 2   // 2× for large canvases (≥1440px longest side)
const SUPERSAMPLE_SM   = 2   // 2× for small canvases too — was 3×, which OOM-kills 1GB worker
                              // Memory at 3× 1080px canvas: 3240×3240×4 = 40MB × 4 concurrent = 160MB
                              // Memory at 2× 1080px canvas: 2160×2160×4 = 18MB × 4 concurrent = 72MB
// JPEG at quality 92 is ~10× faster to encode and ~8× smaller than PNG.
// On a 1366×2048 creative:
//   PNG encode:     ~2000ms,  ~3.2MB  → Cloudinary upload ~3000ms
//   JPEG encode:    ~150ms,   ~350KB  → Cloudinary upload ~300ms
//   Total savings:  ~4500ms per image (~2.3× faster end-to-end)
//
// Quality: JPEG 92 on a catalog photo is visually indistinguishable from
// lossless PNG. Cloudinary delivers f_auto,q_auto on top anyway.
// Transparency: the compositor always fills the canvas with a solid
// background before drawing any layer, so the final canvas never has an
// alpha channel — JPEG is always correct here.
const JPEG_QUALITY = 92
const IMAGE_CACHE_TTL_MS = 10 * 60 * 1000
const IMAGE_CACHE_MAX    = 250

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
  transparentImageUrl?: string | null
  shotTypeOverride?: string | null
  reconstructedBackgroundUrl?: string | null
}

export interface CompositeOptions {
  targetSize?: number
  supersample?: number
  templateMode?: 'standard' | 'ai_product' | 'product_zoom'
  productLayerSettings?: ProductLayerSettings
  storeId?: string
  supabase?: any
  /**
   * NEW (Product Layer Engine): pre-resolved asset bundle from
   * getProductLayerBundle(). When present:
   *  - bundle.backgroundUrl → used as the fixed Background Plate
   *  - bundle.metadata      → used for Smart Fit 2.0 (no detectProductBounds() call)
   * When absent → falls back to existing reconstruction/blur-extend logic.
   * Fully optional — backward compatible with all existing templates.
   */
  productLayerBundle?: CompositorBundle
}

// ─── URL quality helpers — unchanged ──────────────────────────────────────────

function toHighQualityUrl(src: string): string {
  if (!src) return src
  try {
    if (src.includes('res.cloudinary.com') && src.includes('/image/upload/')) {
      const uploadMarker = '/image/upload/'
      const uploadIdx = src.indexOf(uploadMarker)
      const afterUpload = src.slice(uploadIdx + uploadMarker.length)
      const firstSeg = afterUpload.split('/')[0]
      if (/^v\d+$/.test(firstSeg)) return src
      const contentCrops = ['c_crop', 'c_fill', 'c_thumb', 'c_lfill', 'c_imagga_crop', 'c_auto', 'c_pad']
      const hasContentCrop = contentCrops.some(c => firstSeg.includes(c))
      if (hasContentCrop) return src
      const rest = afterUpload.slice(firstSeg.length + 1)
      return src.slice(0, uploadIdx + uploadMarker.length) + rest
    }
    if (src.includes('lh3.googleusercontent.com/d/')) {
      const base = src.replace(/=s\d+[^&]*/, '')
      return base.endsWith('=s0') ? base : base + '=s0'
    }
    if (src.includes('cdn.shopify.com')) {
      return src.replace(
        /(_(\d+x\d*|\d*x\d+)(@\dx)?)(\.(jpg|jpeg|png|webp|gif))(\?.*)?$/i,
        '$4$6'
      )
    }
  } catch {}
  return src
}

async function loadImageUncached(src: string, timeoutMs = 20_000) {
  if (src.startsWith('data:')) return loadImage(src)
  const highQualitySrc = toHighQualityUrl(src)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(highQualitySrc, { signal: controller.signal, cache: 'force-cache' })
    if (!res.ok) {
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

async function preloadRenderableImages(
  canvasData: CanvasData,
  product: { imageUrl: string | null; reconstructedBackgroundUrl?: string | null },
  bundle?: CompositorBundle
) {
  const urls = new Set<string>()
  const settings: BackgroundSettings = canvasData.backgroundSettings ?? DEFAULT_BACKGROUND_SETTINGS

  // NEW: if bundle has a background plate, preload it too
  if (bundle?.backgroundUrl) {
    urls.add(bundle.backgroundUrl)
  }

  if (settings.mode === 'solid' && canvasData.backgroundImageUrl) {
    urls.add(canvasData.backgroundImageUrl)
  }
  if (settings.mode === 'original' && product.reconstructedBackgroundUrl) {
    urls.add(product.reconstructedBackgroundUrl)
  }
  if (settings.mode !== 'solid' && settings.mode !== 'transparent' && settings.mode !== 'original' && product.imageUrl) {
    urls.add(product.imageUrl)
  }

  for (const layer of canvasData.layers) {
    if (!['overlay', 'logo', 'sticker', 'image'].includes(layer.type)) continue
    const imageLayer = layer as Layer & { src?: string }
    const src = imageLayer.src === '{{product_image}}' ? product.imageUrl : imageLayer.src
    if (src) urls.add(src)
  }

  await mapWithConcurrency([...urls], 6, async src => {
    try { await loadImageSafe(src) } catch {}
  })
}

// ─── Background renderers ──────────────────────────────────────────────────────

interface RgbColor { r: number; g: number; b: number }

function serverExtractDominantColors(ctx: any, imgNode: any, count = 2): RgbColor[] {
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

function computeCoverFit(imgW: number, imgH: number, boxW: number, boxH: number, zoomFactor = 1) {
  const scale = Math.max(boxW / imgW, boxH / imgH) * zoomFactor
  const sw = imgW * scale
  const sh = imgH * scale
  return { sx: (boxW - sw) / 2, sy: (boxH - sh) / 2, sw, sh }
}

function serverRenderBlurExtend(ctx: any, imgNode: any, W: number, H: number, blurStrength: number) {
  const { sx, sy, sw, sh } = computeCoverFit(imgNode.width, imgNode.height, W, H, 1.15)
  ctx.save()
  ctx.filter = `blur(${blurStrength}px) saturate(1.2) brightness(0.9)`
  ctx.drawImage(imgNode, sx, sy, sw, sh)
  ctx.filter = 'none'
  ctx.restore()
}

const POSITIONING_GAP_BLUR = 30

function drawBlurredBackdropInBox(ctx: any, imgNode: any, x: number, y: number, w: number, h: number) {
  const { sx, sy, sw, sh } = computeCoverFit(imgNode.width, imgNode.height, w, h, 1.15)
  ctx.save()
  ctx.filter = `blur(${POSITIONING_GAP_BLUR}px) saturate(1.1) brightness(0.95)`
  ctx.drawImage(imgNode, x + sx, y + sy, sw, sh)
  ctx.filter = 'none'
  ctx.restore()
}

function drawCoverFit(ctx: any, imgNode: any, x: number, y: number, w: number, h: number) {
  const { sx, sy, sw, sh } = computeCoverFit(imgNode.width, imgNode.height, w, h, 1)
  ctx.drawImage(imgNode, x + sx, y + sy, sw, sh)
}

/**
 * Render the background layer.
 *
 * CHANGED (Product Layer Engine): when options.productLayerBundle.backgroundUrl
 * is present, render the pre-computed Background Plate FIRST as the fixed
 * studio backdrop — then return. The Background Plate always wins over
 * blur-extend/reconstruction when available.
 *
 * All existing modes (solid, transparent, original, blur-extend, smart,
 * gradient) are preserved byte-identical as fallbacks.
 */
async function serverRenderBackground(
  ctx: any,
  canvasData: CanvasData,
  product: { imageUrl: string | null; reconstructedBackgroundUrl?: string | null; transparentImageUrl?: string | null },
  W: number,
  H: number,
  bundle?: CompositorBundle,
  templateMode?: 'standard' | 'ai_product' | 'product_zoom'
): Promise<void> {
  // In ai_product mode with a resolved cutout, the original photo (with the
  // model still in it) must never be loaded as the backdrop — mirrors the
  // client preview's `sampleSrc = null` guard in canvas-preview.tsx. Without
  // this, blur-extend/smart/gradient modes draw the original photo behind the
  // sharp cutout, producing a visible duplicate product.
  const isAiProduct = templateMode === 'ai_product' && Boolean(product.transparentImageUrl)
  const settings: BackgroundSettings = canvasData.backgroundSettings ?? DEFAULT_BACKGROUND_SETTINGS

  // ── NEW: Product Zoom Mode — solid fill only ──────────────────────────────
  // The original photo already includes its own studio backdrop and is drawn
  // as a single unit below (see compositeImage()'s product_zoom branch). Any
  // letterbox gap left by satisfying Head Space/Bottom Space must be flat
  // color, never a second rendering pass of the photo (no blur-extend/smart/
  // gradient sampling of the same image behind itself).
  if (templateMode === 'product_zoom') {
    ctx.fillStyle = canvasData.backgroundColor
    ctx.fillRect(0, 0, W, H)
    return
  }
  // ── End new block ─────────────────────────────────────────────────────────

  // ── NEW: Background Plate (Product Layer Engine) ─────────────────────────
  // If we have a pre-computed Background Plate, use it as the fixed backdrop.
  // It was generated once by getProductLayerBundle() and cached permanently.
  // It is NEVER regenerated on subsequent jobs — just loaded from Cloudinary.
  //
  // The plate is always drawn at full canvas coverage regardless of the
  // backgroundSettings.mode — it is the ground truth for the 'original'
  // background mode. For other modes (solid, blur-extend, gradient, smart,
  // transparent), the plate is skipped and the existing renderer handles them.
  if (bundle?.backgroundUrl && settings.mode === 'original') {
    // Solid fill as fallback baseline (same as before)
    ctx.fillStyle = canvasData.backgroundColor
    ctx.fillRect(0, 0, W, H)
    try {
      const bgPlate = await loadImageSafe(bundle.backgroundUrl)
      drawCoverFit(ctx, bgPlate, 0, 0, W, H)
      console.log(`[compositor] Background Plate rendered (${W}×${H})`)
      return  // Background Plate is the final word — no further drawing
    } catch (err: any) {
      console.warn('[compositor] Background Plate load failed, falling through to solid:', err.message)
      return  // solid fill (already drawn above) is the fallback
    }
  }
  // ── End new block ─────────────────────────────────────────────────────────

  // All existing background rendering — UNCHANGED from original compositor.ts
  ctx.fillStyle = canvasData.backgroundColor
  ctx.fillRect(0, 0, W, H)

  if (settings.mode === 'solid') {
    if (canvasData.backgroundImageUrl) {
      try {
        const bgImg = await loadImageSafe(canvasData.backgroundImageUrl)
        ctx.drawImage(bgImg, 0, 0, W, H)
      } catch {}
    }
    return
  }

  if (settings.mode === 'transparent') {
    ctx.clearRect(0, 0, W, H)
    return
  }

  if (settings.mode === 'original') {
    // Legacy path (no bundle.backgroundUrl) — existing reconstruction logic
    if (product.reconstructedBackgroundUrl) {
      try {
        const bgImg = await loadImageSafe(product.reconstructedBackgroundUrl)
        drawCoverFit(ctx, bgImg, 0, 0, W, H)
      } catch {}
    }
    return
  }

  const imgSrc = isAiProduct ? null : product.imageUrl
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

// ─── AI Product Layer Renderer — unchanged ─────────────────────────────────────

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

  if (settings.rotation !== 0) {
    ctx.translate(x + w / 2, y + h / 2)
    ctx.rotate((settings.rotation * Math.PI) / 180)
    ctx.translate(-(x + w / 2), -(y + h / 2))
  }

  if (settings.flipH || settings.flipV) {
    ctx.translate(x + w / 2, y + h / 2)
    ctx.scale(settings.flipH ? -1 : 1, settings.flipV ? -1 : 1)
    ctx.translate(-(x + w / 2), -(y + h / 2))
  }

  if (settings.shadow) {
    ctx.shadowColor = settings.shadowColor
    ctx.shadowBlur = settings.shadowBlur
    ctx.shadowOffsetX = settings.shadowOffsetX
    ctx.shadowOffsetY = settings.shadowOffsetY
  }

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
    ctx.drawImage(img, 0, 0, img.width, img.height, x, y, w, h)
  }
}

// ─── Main Composite Function ──────────────────────────────────────────────────

export async function compositeImage(
  canvasData: CanvasData,
  product: ProductData,
  options: CompositeOptions = {}
): Promise<Buffer> {
  return measureAsync('creative.render.total', async () => {
    ensureFontsRegistered()

    const rawW = canvasData.width  || 1080
    const rawH = canvasData.height || 1080

    let targetW: number
    let targetH: number

    if (rawW >= OUTPUT_SIZE || rawH >= OUTPUT_SIZE) {
      targetW = rawW
      targetH = rawH
    } else {
      const upScale = OUTPUT_SIZE / Math.max(rawW, rawH)
      targetW = Math.round(rawW * upScale / 2) * 2
      targetH = Math.round(rawH * upScale / 2) * 2
    }

    const S = chooseSuperSample(targetW, targetH, options.supersample)
    const W = targetW * S
    const H = targetH * S

    console.log(
      `[compositor] render ${rawW}×${rawH} template → ${targetW}×${targetH} output ` +
      `(SS=${S}, internal=${W}×${H}, RAM≈${Math.round(W*H*4/1e6)}MB, ` +
      `bundle=${options.productLayerBundle ? 'yes' : 'no'})`
    )

    const canvas = createCanvas(W, H)
    const ctx = canvas.getContext('2d')
    if ('imageSmoothingEnabled' in ctx) ctx.imageSmoothingEnabled = true
    if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high'

    await measureAsync('creative.render.asset_preload', () =>
      preloadRenderableImages(canvasData, product, options.productLayerBundle),
      { layers: canvasData.layers.length }
    )

    const templateMode = options.templateMode || 'standard'

    // Background — now accepts bundle for Background Plate rendering
    await serverRenderBackground(ctx, canvasData, product, W, H, options.productLayerBundle, templateMode)

    let productLayerSettings = options.productLayerSettings || DEFAULT_PRODUCT_LAYER_SETTINGS

    if (templateMode === 'ai_product' && product.transparentImageUrl) {
      // ── Product Positioning (Head Space) — ai_product mode ─────────────────
      //
      // CHANGED (Product Layer Engine): when bundle.metadata is present, use
      // calculateSmartFitPlacement() which reads from stored metadata instead
      // of calling resolveProductPositioning() (which calls detectProductBounds()
      // — a network round-trip to load and pixel-scan the transparent PNG).
      //
      // Fallback: when no metadata is available (legacy images or first run
      // before the bundle is cached), fall back to the original
      // resolveProductPositioning() path — preserves 100% parity for all
      // existing templates and images that haven't been through the engine yet.

      const positioningSettings = canvasData.productPositioningSettings
      const bundle = options.productLayerBundle

      if (positioningSettings?.enabled && bundle?.metadata) {
        // ── Smart Fit 2.0: zero network calls, pure math from stored metadata ──
        const { placement, wouldCrop } = calculateSmartFitPlacement(
          bundle.metadata,
          rawW,
          rawH,
          positioningSettings
        )
        if (!wouldCrop && placement) {
          productLayerSettings = placementToProductLayerSettings(
            placement, rawW, rawH, productLayerSettings
          )
          console.log(
            `[compositor] Smart Fit 2.0: head_y=${bundle.metadata.head_y}px ` +
            `shot=${bundle.metadata.shot_type} scale=${placement.scale.toFixed(3)}`
          )
        }
      } else if (positioningSettings?.enabled) {
        // ── Legacy path: resolveProductPositioning (detectProductBounds + classify) ─
        // Used when bundle metadata isn't available yet (first-run / legacy rows).
        const positioning = await resolveProductPositioning(
          product.transparentImageUrl,
          rawW, rawH,
          positioningSettings,
          product.shotTypeOverride
        )
        if (positioning.apply && positioning.placement) {
          productLayerSettings = placementToProductLayerSettings(
            positioning.placement, rawW, rawH, productLayerSettings
          )
        }
      }

      const isRawProductImageLayer = (l: Layer) =>
        (l.type === 'image' || l.type === 'overlay' || l.type === 'logo' || l.type === 'sticker') &&
        (l as any).src === '{{product_image}}'

      const allLayers = [...canvasData.layers]
        .filter(l => !isRawProductImageLayer(l))
        .sort((a, b) => a.zIndex - b.zIndex)
      const bgLayers = allLayers.filter(l => l.zIndex < productLayerSettings.zIndex)
      const fgLayers = allLayers.filter(l => l.zIndex >= productLayerSettings.zIndex)

      const layerOpts = { storeId: options.storeId, supabase: options.supabase, targetW, targetH }

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
    } else if (templateMode === 'product_zoom' && product.imageUrl) {
      // ── Product Zoom Mode — whole original photo, zoomed/positioned as one unit ──
      //
      // No background removal, no cutout, no separate background layer: the
      // original photo (background + product together) is drawn exactly once.
      // Head Space / Bottom Space reuse the exact same classify+placement math
      // as Standard Mode's Head Space feature (classifyProductImage /
      // calculatePlacement, already imported above) — the only difference is
      // there is no blurred-backdrop gap fill and no per-layer clip box: the
      // photo always occupies the full canvas, and any letterbox gap left by
      // satisfying both guides shows the plain background color already
      // painted by serverRenderBackground() above.
      const positioningSettings = canvasData.productPositioningSettings
      let zoomPlacement: { imgX: number; imgY: number; renderedW: number; renderedH: number } | null = null

      if (positioningSettings?.enabled) {
        try {
          const classified = await classifyProductZoomImage(product.imageUrl, positioningSettings, product.shotTypeOverride)
          // Apply placement only when detection succeeded AND the shot type is in the
          // user's allow-list. Both checks are already folded into classified.applies:
          //   classified.applies = !isDegenerateBounds(bounds) && applyToShotTypes.includes(shotType)
          //
          // Do NOT override this with a fill-mode bypass. Fill mode changes HOW the image
          // is scaled (height-first, may crop sides), NOT which shots get framed.
          // Bypassing the shot type check with "|| scaleMode === 'fill'" was the direct
          // cause of half-body/close-up shots being zoomed into extreme closeups:
          // a half-body photo has no feet, so "fill" used the waist as the bottom guide
          // and blew the image up 3× into a closeup of fabric/skin.
          if (classified.applies) {
            const scaleX = W / rawW
            const scaleY = H / rawH
            const scaledSettings = {
              ...positioningSettings,
              headSpacePx:    positioningSettings.headSpacePx    * scaleY,
              leftMarginPx:   positioningSettings.leftMarginPx   * scaleX,
              rightMarginPx:  positioningSettings.rightMarginPx  * scaleX,
              bottomMarginPx: positioningSettings.bottomMarginPx * scaleY,
            }
            const { placement: computed, wouldCrop } = calculatePlacement(classified.bounds, W, H, scaledSettings)
            if (!wouldCrop) zoomPlacement = computed
          }
        } catch (err: any) {
          console.warn('[product-positioning] product_zoom classification failed, bypassing:', err?.message)
        }
      }

      try {
        const img = await loadImageSafe(product.imageUrl)
        if (zoomPlacement) {
          const { imgX, imgY, renderedW, renderedH } = zoomPlacement

          // ── Check if the image covers the full canvas ───────────────────────
          // If imgY > 0: white/blank space above the image
          // If imgX > 0: blank space to the left
          // If image doesn't reach canvas bottom: blank space below
          // If image doesn't reach canvas right: blank space to the right
          //
          // When there IS exposed canvas AND storeId+supabase are available,
          // call AI extend so the background is seamlessly filled instead of
          // showing the canvas background color (which looks like padding).
          const hasExposedArea =
            imgY > 1 || imgX > 1 ||
            imgY + renderedH < H - 1 ||
            imgX + renderedW < W - 1

          if (hasExposedArea && positioningSettings?.aiExtend !== false && options.storeId && options.supabase) {
            try {
              // Convert supersampled coordinates back to 1× for the extend call
              // (getExtendedImagePositioned works in 1× space, compositor handles scaling)
              const extResult = await getExtendedImagePositioned(
                product.imageUrl,
                rawW, rawH,         // 1× canvas dimensions
                imgX / S, imgY / S, // 1× offsets
                renderedW / S, renderedH / S, // 1× rendered size
                options.storeId,
                options.supabase
              )
              console.log(`[compositor] product_zoom AI extend ${extResult.fromCache ? 'cached' : 'fresh'} ` +
                `offset=(${Math.round(imgX/S)},${Math.round(imgY/S)}) rendered=${Math.round(renderedW/S)}×${Math.round(renderedH/S)}`)
              // Draw the AI-extended image (fills full canvas)
              const extImg = await loadImageSafe(extResult.extendedUrl)
              ctx.drawImage(extImg, 0, 0, W, H)
            } catch (extErr: any) {
              console.warn('[compositor] product_zoom AI extend failed, drawing plain image:', extErr.message)
              // Fallback: draw plain image at calculated position
              ctx.drawImage(img, 0, 0, img.width, img.height, imgX, imgY, renderedW, renderedH)
            }
          } else {
            // Image covers the full canvas (or AI extend not available) — draw directly
            ctx.drawImage(img, 0, 0, img.width, img.height, imgX, imgY, renderedW, renderedH)
          }
        } else {
          // No positioning configured / doesn't apply / would crop — plain
          // contain-fit to the full canvas. Never crops, never stretches.
          drawFittedImage(ctx, img, 0, 0, W, H, 'contain')
        }
      } catch (err: any) {
        console.error('[compositor] product_zoom image load failed:', err?.message)
      }

      const isRawProductImageLayerZoom = (l: Layer) =>
        (l.type === 'image' || l.type === 'overlay' || l.type === 'logo' || l.type === 'sticker') &&
        (l as any).src === '{{product_image}}'

      const decorativeLayers = [...canvasData.layers]
        .filter(l => !isRawProductImageLayerZoom(l))
        .sort((a, b) => a.zIndex - b.zIndex)

      const zoomLayerOpts = { storeId: options.storeId, supabase: options.supabase, targetW, targetH }
      for (const layer of decorativeLayers) {
        await drawLayer(ctx, layer, product, W, H, zoomLayerOpts)
      }
    } else {
      // ── Standard mode — unchanged ────────────────────────────────────────────
      let standardModePositioning: ClassifyResult | null = null
      const positioningSettings = canvasData.productPositioningSettings
      if (positioningSettings?.enabled && product.imageUrl) {
        try {
          const classified = await classifyProductImage(product.imageUrl, positioningSettings, product.shotTypeOverride)
          if (classified.applies) standardModePositioning = classified
        } catch (err: any) {
          console.warn('[product-positioning] standard-mode classification failed, bypassing:', err?.message)
        }
      }

      const layerOpts = {
        storeId: options.storeId,
        supabase: options.supabase,
        targetW,
        targetH,
        rawW,
        rawH,
        standardModePositioning: standardModePositioning
          ? { bounds: standardModePositioning.bounds, settings: positioningSettings! }
          : null,
      }

      const sorted = [...canvasData.layers].sort((a, b) => a.zIndex - b.zIndex)
      for (const layer of sorted) {
        await drawLayer(ctx, layer, product, W, H, layerOpts)
      }
    }

    // ── Multi-step quality downscale — unchanged ───────────────────────────────
    let finalCanvas: Canvas

    if (S === 1) {
      finalCanvas = canvas
    } else {
      let currentCanvas = canvas
      let currentW = W
      let currentH = H

      while (currentW > targetW * 1.5 || currentH > targetH * 1.5) {
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

    const encodeStarted = Date.now()
    const buffer = (finalCanvas as any).toBuffer('image/jpeg', { quality: JPEG_QUALITY })
    logPerf('creative.render.jpeg_encode', Date.now() - encodeStarted, {
      bytes: buffer.length,
      width: targetW,
      height: targetH,
      supersample: S,
    })
    return buffer
  }, { layers: canvasData.layers.length })
}

/** Draw a single layer — unchanged from original */
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
    rawW?: number
    rawH?: number
    standardModePositioning?: { bounds: ProductBounds; settings: ProductPositioningSettings } | null
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
        let positioningPlacement: { imgX: number; imgY: number; renderedW: number; renderedH: number } | null = null
        if (l.src === '{{product_image}}' && options?.standardModePositioning) {
          const { bounds, settings } = options.standardModePositioning
          const rawW = options.rawW ?? W
          const rawH = options.rawH ?? H
          const scaleX = W / rawW
          const scaleY = H / rawH
          const scaledSettings = {
            ...settings,
            headSpacePx:    settings.headSpacePx    * scaleY,
            leftMarginPx:   settings.leftMarginPx   * scaleX,
            rightMarginPx:  settings.rightMarginPx  * scaleX,
            bottomMarginPx: settings.bottomMarginPx * scaleY,
          }
          const { placement, wouldCrop } = calculatePlacement(bounds, w, h, scaledSettings)
          if (!wouldCrop) positioningPlacement = placement
        }

        let resolvedSrc = imgSrc
        if (!positioningPlacement && fit === 'ai_extend' && l.src === '{{product_image}}' && options?.storeId && options?.supabase) {
          const extTargetW = options.targetW ?? W
          const extTargetH = options.targetH ?? H
          const imgForCheck = await loadImageSafe(imgSrc).catch(() => null)
          const actualNeedsExtend = imgForCheck
            ? needsExtend(imgForCheck.width, imgForCheck.height, extTargetW, extTargetH)
            : true

          if (actualNeedsExtend) {
            try {
              const extendResult = await getExtendedImage(
                imgSrc,
                extTargetW,
                extTargetH,
                options.storeId,
                options.supabase
              )
              resolvedSrc = extendResult.extendedUrl
              console.log(`[compositor] AI extend ${extendResult.fromCache ? 'cached' : 'fresh'} for ${imgSrc.slice(0, 50)}`)
            } catch (extErr: any) {
              console.error('[compositor] AI extend failed, falling back to contain:', extErr.message)
            }
          }
        }

        try {
          const img = await loadImageSafe(resolvedSrc)
          ctx.save()
          if (positioningPlacement) {
            roundRect(ctx, x, y, w, h, radius)
            ctx.clip()
            drawBlurredBackdropInBox(ctx, img, x, y, w, h)
            ctx.drawImage(
              img, 0, 0, img.width, img.height,
              x + positioningPlacement.imgX, y + positioningPlacement.imgY,
              positioningPlacement.renderedW, positioningPlacement.renderedH
            )
          } else {
            if (radius > 0) {
              roundRect(ctx, x, y, w, h, radius)
              ctx.clip()
            }
            const drawFit = fit === 'ai_extend' ? 'cover' : fit as 'cover' | 'contain' | 'fill'
            drawFittedImage(ctx, img, x, y, w, h, drawFit)
          }
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

function roundRect(ctx: any, x: number, y: number, w: number, h: number, r: number) {
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