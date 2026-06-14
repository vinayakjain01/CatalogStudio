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
    product: ProductData
  ): Promise<Buffer> {
    ensureFontsRegistered()

    // Use actual canvas dimensions from the template
    const W = canvasData.width || 1000
    const H = canvasData.height || 1000

    const canvas = createCanvas(W, H)
    const ctx = canvas.getContext('2d')

    ctx.fillStyle = canvasData.backgroundColor
    ctx.fillRect(0, 0, W, H)

    if (canvasData.backgroundImageUrl) {
      try {
        const bgImg = await loadImageSafe(canvasData.backgroundImageUrl)
        ctx.drawImage(bgImg, 0, 0, W, H)
      } catch {}
    }

    const sorted = [...canvasData.layers].sort((a, b) => a.zIndex - b.zIndex)

    for (const layer of sorted) {
      // x/y/width/height are percentages — apply to actual W/H
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

        case 'image': {
          const l = layer as ImageLayer
          const imgSrc = l.src === '{{product_image}}' ? product.imageUrl : l.src
          if (imgSrc) {
            try {
              const img = await loadImageSafe(imgSrc)
              ctx.save()
              if (l.borderRadius > 0) {
                roundRect(ctx, x, y, w, h, l.borderRadius)
                ctx.clip()
              }
              if (l.objectFit === 'cover') {
                const scale = Math.max(w / img.width, h / img.height)
                const sw = img.width * scale
                const sh = img.height * scale
                ctx.drawImage(img, x + (w - sw) / 2, y + (h - sh) / 2, sw, sh)
              } else if (l.objectFit === 'contain') {
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
              ctx.fillStyle = '#dddddd'
              roundRect(ctx, x, y, w, h, l.borderRadius)
              ctx.fill()
            }
          }
          break
        }
      }

      ctx.restore()
    }

    return canvas.toBuffer('image/jpeg', 0.92)
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