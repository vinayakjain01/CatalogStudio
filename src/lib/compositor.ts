import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas'
import path from 'path'
import { CanvasData, Layer, TextLayer, ImageLayer, RectangleLayer, BadgeLayer, BackgroundSettings, DEFAULT_BACKGROUND_SETTINGS } from '@/types/template'
import { resolveVariables } from '@/types/template'

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
}

export interface CompositeOptions {
  /** Final delivered dimension in px (square). Default 1080. */
  targetSize?: number
  /** Internal render multiplier. Default 2. */
  supersample?: number
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
async function loadImageSafe(src: string, timeoutMs = 12_000) {
  // data: URLs and local buffers pass straight through
  if (src.startsWith('data:')) return loadImage(src)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(src, { signal: controller.signal })
    if (!res.ok) throw new Error(`image fetch ${res.status} for ${src}`)
    const buf = Buffer.from(await res.arrayBuffer())
    return await loadImage(buf)
  } finally {
    clearTimeout(timer)
  }
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
  export async function compositeImage(
    canvasData: CanvasData,
    product: ProductData
  ): Promise<Buffer> {
    ensureFontsRegistered()

    // Use actual canvas dimensions from the template
    const W = canvasData.width || 1080
    const H = canvasData.height || 1080

    const canvas = createCanvas(W, H)
    const ctx = canvas.getContext('2d')

    // Background
    await serverRenderBackground(ctx, canvasData, product, W, H)

    const sorted = [...canvasData.layers].sort(
      (a, b) => a.zIndex - b.zIndex
    )

    for (const layer of sorted) {
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
          // Scale font size proportionally to canvas width
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
          // overlay/logo/sticker carry an uploaded `src`; image may carry the
          // product-image token. All four draw a remote image the same way.
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
              ctx.restore()
            } catch (err: any) {
              console.error('[compositor] image load failed:', imgSrc, err?.message)
              // Only show a grey placeholder for the product image; for
              // overlay/logo/sticker a load failure should be silent (no ugly box).
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

    // Lossless PNG master. The single lossy pass happens at Cloudinary delivery
    // (f_auto,q_auto:good). Must stay PNG: the upload route validates the PNG
    // signature (0x89 0x50) and the quality pipeline depends on a lossless master.
    return canvas.toBuffer('image/png')
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