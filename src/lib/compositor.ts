import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas'
import path from 'path'
import { CanvasData, Layer, TextLayer, RectangleLayer, BadgeLayer } from '@/types/template'
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

export async function compositeImage(
  canvasData: CanvasData,
  product: ProductData,
  options: CompositeOptions = {}
): Promise<Buffer> {
  ensureFontsRegistered()

  const targetSize = options.targetSize ?? DEFAULT_TARGET_SIZE
  const supersample = options.supersample ?? SUPERSAMPLE
  const SIZE = targetSize * supersample

  const canvas = createCanvas(SIZE, SIZE)
  const ctx = canvas.getContext('2d')

  // High-quality scaling for every drawImage call (product photo, bg, logos).
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'

  // Background
  ctx.fillStyle = canvasData.backgroundColor
  ctx.fillRect(0, 0, SIZE, SIZE)

  if (canvasData.backgroundImageUrl) {
    try {
      const bgImg = await loadImageSafe(toFullResolution(canvasData.backgroundImageUrl))
      ctx.drawImage(bgImg, 0, 0, SIZE, SIZE)
    } catch {}
  }

  // Sort layers by zIndex
  const sorted = [...canvasData.layers].sort((a, b) => a.zIndex - b.zIndex)

  for (const layer of sorted) {
    const x = (layer.x / 100) * SIZE
    const y = (layer.y / 100) * SIZE
    const w = (layer.width / 100) * SIZE
    const h = (layer.height / 100) * SIZE

    ctx.save()
    ctx.globalAlpha = layer.opacity

    // Rotation around layer center
    if (layer.rotation !== 0) {
      ctx.translate(x + w / 2, y + h / 2)
      ctx.rotate((layer.rotation * Math.PI) / 180)
      ctx.translate(-(x + w / 2), -(y + h / 2))
    }

    switch (layer.type) {
      case 'rectangle': {
        const l = layer as RectangleLayer
        ctx.fillStyle = l.backgroundColor
        roundRect(ctx, x, y, w, h, l.borderRadius * supersample)
        ctx.fill()
        if (l.borderWidth > 0) {
          ctx.strokeStyle = l.borderColor
          ctx.lineWidth = l.borderWidth * supersample
          roundRect(ctx, x, y, w, h, l.borderRadius * supersample)
          ctx.stroke()
        }
        break
      }

      case 'text': {
        const l = layer as TextLayer
        const text = resolveVariables(l.content, product)
        const family = l.fontWeight === 'bold' ? 'Inter Bold' : 'Inter'
        // fontSize is authored at the 1000px design space; scale to device px.
        const fontPx = l.fontSize * (SIZE / 1000)
        ctx.font = `${fontPx}px "${family}"`
        ctx.fillStyle = l.color
        ctx.textBaseline = 'top'
        ctx.textAlign = l.textAlign as CanvasTextAlign

        if (l.backgroundColor) {
          ctx.fillStyle = l.backgroundColor
          roundRect(ctx, x, y, w, h, l.borderRadius * supersample)
          ctx.fill()
          ctx.fillStyle = l.color
        }

        const padX = l.paddingX * supersample
        const padY = l.paddingY * supersample
        const textX =
          l.textAlign === 'center'
            ? x + w / 2
            : l.textAlign === 'right'
            ? x + w - padX
            : x + padX
        ctx.fillText(text, textX, y + padY, w - padX * 2)
        break
      }

      case 'badge': {
        const l = layer as BadgeLayer
        const text = resolveVariables(l.content, product)
        const radius = l.shape === 'circle' ? Math.min(w, h) / 2 : l.borderRadius * supersample
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
        const fontPx = l.fontSize * (SIZE / 1000)
        ctx.font = `${fontPx}px "${family}"`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(text, x + w / 2, y + h / 2, w)
        break
      }

      case 'overlay':
      case 'logo':
      case 'sticker':
      case 'image': {
        // overlay/logo carry an explicit uploaded `src`; image may carry the
        // product-image token. All three draw the same way.
        const l = layer as Layer & {
          src: string
          objectFit?: 'cover' | 'contain' | 'fill'
          borderRadius?: number
        }
        const rawSrc = l.src === '{{product_image}}' ? product.imageUrl : l.src
        const imgSrc = rawSrc ? toFullResolution(rawSrc) : null
        const fit = l.objectFit || 'contain'
        const radius = (l as any).borderRadius ?? 0
        if (imgSrc) {
          try {
            const img = await loadImageSafe(imgSrc)
            ctx.save()
            if (radius > 0) {
              roundRect(ctx, x, y, w, h, radius * supersample)
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
          } catch (err) {
            console.error(`Failed to load image layer (${l.id}):`, imgSrc, err)
            // For product images, show a visible placeholder. For overlay/logo
            // a load failure should be silent (no ugly grey box on export).
            if (layer.type === 'image') {
              ctx.fillStyle = '#e5e7eb'
              roundRect(ctx, x, y, w, h, radius * supersample)
              ctx.fill()
            }
          }
        }
        break
      }
    }

    ctx.restore()
  }

  // LOSSLESS master. Cloudinary applies the single lossy pass at delivery.
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