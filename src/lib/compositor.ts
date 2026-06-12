import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas'
import path from 'path'
import { CanvasData, Layer, TextLayer, ImageLayer, RectangleLayer, BadgeLayer } from '@/types/template'
import { resolveVariables } from '@/types/template'

const SIZE = 1000

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

export async function compositeImage(
  canvasData: CanvasData,
  product: ProductData
): Promise<Buffer> {
  ensureFontsRegistered()

  const canvas = createCanvas(SIZE, SIZE)
  const ctx = canvas.getContext('2d')

  // Background
  ctx.fillStyle = canvasData.backgroundColor
  ctx.fillRect(0, 0, SIZE, SIZE)

  if (canvasData.backgroundImageUrl) {
    try {
      const bgImg = await loadImage(canvasData.backgroundImageUrl)
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
        ctx.font = `${l.fontSize}px "${family}"`
        ctx.fillStyle = l.color
        ctx.textBaseline = 'top'
        ctx.textAlign = l.textAlign as CanvasTextAlign

        if (l.backgroundColor) {
            ctx.fillStyle = l.backgroundColor
            roundRect(ctx, x, y, w, h, l.borderRadius)
            ctx.fill()
            ctx.fillStyle = l.color
        }

        const textX = l.textAlign === 'center' ? x + w / 2 : l.textAlign === 'right' ? x + w - l.paddingX : x + l.paddingX
        ctx.fillText(text, textX, y + l.paddingY, w - l.paddingX * 2)
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
        ctx.font = `${l.fontSize}px "${family}"`
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
            const img = await loadImage(imgSrc)
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
            } catch (err) {
            console.error(`Failed to load image layer (${l.id}):`, imgSrc, err)
            // Draw a visible placeholder so failures are obvious
            ctx.fillStyle = '#e5e7eb'
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