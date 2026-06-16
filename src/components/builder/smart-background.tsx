'use client'

/**
 * smart-background.tsx
 *
 * Client-side canvas utilities for the "Smart Background" feature.
 *
 * All rendering happens on an offscreen <canvas> so the rest of the builder
 * stays untouched.  The exported hook `useSmartBackground` returns a CSS
 * `backgroundImage` data-URL string (or null while computing) that can be
 * dropped directly onto the canvas preview div.
 *
 * Nothing here touches Zustand, the layer system, or the compositor — it is
 * purely a visual effect layer rendered on top of the existing backgroundColor.
 */

import { useEffect, useRef, useState } from 'react'
import { BackgroundMode, BackgroundSettings, DEFAULT_BACKGROUND_SETTINGS } from '@/types/template'

// ─── Color analysis ──────────────────────────────────────────────────────────

export interface RgbColor {
  r: number
  g: number
  b: number
}

/**
 * Sample an image drawn onto a small offscreen canvas and return the top-N
 * dominant colors using a simple bucket-quantisation approach.
 * Runs synchronously after the image is already on-canvas.
 */
function extractDominantColors(
  img: HTMLImageElement | null,
  count = 3
): RgbColor[] {
  if (!img) return [{ r: 240, g: 240, b: 240 }]
  const size = 64
  const c = document.createElement('canvas')
  c.width = size
  c.height = size
  const ctx = c.getContext('2d')!
  ctx.drawImage(img, 0, 0, size, size)
  const data = ctx.getImageData(0, 0, size, size).data

  // Reduce to 4-bit per channel buckets (4096 possible colors)
  const buckets: Record<string, { r: number; g: number; b: number; count: number }> = {}
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]
    if (a < 64) continue // skip transparent / near-transparent
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

function rgbToHex({ r, g, b }: RgbColor): string {
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')
}

// ─── Background renderers ────────────────────────────────────────────────────

/**
 * Render a blurred + zoomed version of the image as a background.
 * This is the "Instagram / Canva" style that fills all empty space naturally.
 */
function renderBlurExtend(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  W: number,
  H: number,
  blurStrength: number
) {
  // Scale image to cover the full canvas (may be larger)
  const scale = Math.max(W / img.width, H / img.height) * 1.15 // 15% zoom for edge coverage
  const sw = img.width * scale
  const sh = img.height * scale
  const sx = (W - sw) / 2
  const sy = (H - sh) / 2

  ctx.save()
  ctx.filter = `blur(${blurStrength}px) saturate(1.2) brightness(0.9)`
  ctx.drawImage(img, sx, sy, sw, sh)
  ctx.filter = 'none'
  ctx.restore()
}

/**
 * Smart fill: blur-extend + a soft gradient vignette derived from the image's
 * dominant colors, blended on top.  Creates a more designed look than raw blur.
 */
function renderSmartFill(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement | null,
  W: number,
  H: number,
  settings: BackgroundSettings,
  fallbackColor: string
) {
  if (!img) {
    ctx.fillStyle = fallbackColor
    ctx.fillRect(0, 0, W, H)
    return
  }

  // 1. Blur-extend base
  renderBlurExtend(ctx, img, W, H, settings.blurStrength)

  // 2. Soft radial overlay from dominant color to transparent — adds polish
  const colors = extractDominantColors(img, 2)
  if (colors.length > 0) {
    const c = colors[0]
    const radial = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.7)
    radial.addColorStop(0, `rgba(${c.r},${c.g},${c.b},0)`)
    radial.addColorStop(1, `rgba(${c.r},${c.g},${c.b},${settings.blendStrength * 0.5})`)
    ctx.fillStyle = radial
    ctx.fillRect(0, 0, W, H)
  }
}

/**
 * Gradient fill: 2-stop CSS-style linear gradient.
 * When autoColors is on, derives stops from the image's dominant palette.
 */
function renderGradient(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement | null,
  W: number,
  H: number,
  settings: BackgroundSettings
) {
  let stops = settings.gradientStops
  if (settings.autoColors && img) {
    const colors = extractDominantColors(img, 2)
    if (colors.length >= 2) {
      stops = [
        { color: rgbToHex(colors[0]), position: 0 },
        { color: rgbToHex(colors[1]), position: 100 },
      ]
    } else if (colors.length === 1) {
      // Single dominant color → lighten one stop
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
  const cx = W / 2
  const cy = H / 2
  const grad = ctx.createLinearGradient(
    cx - (dx * len) / 2,
    cy - (dy * len) / 2,
    cx + (dx * len) / 2,
    cy + (dy * len) / 2
  )
  for (const stop of stops) {
    grad.addColorStop(stop.position / 100, stop.color)
  }
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, W, H)
}

// ─── Master renderer ─────────────────────────────────────────────────────────

/**
 * Render the background layer to an offscreen canvas and return a data-URL.
 * Returns null for 'solid' and 'transparent' modes — those are handled with
 * plain CSS background-color, not a generated image.
 */
export function renderBackgroundToDataUrl(
  mode: BackgroundMode,
  img: HTMLImageElement | null,
  W: number,
  H: number,
  settings: BackgroundSettings,
  solidColor: string
): string | null {
  if (mode === 'solid' || mode === 'transparent') return null

  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const ctx = c.getContext('2d')!

  // Fill with solid color first so there's never a flash of white
  ctx.fillStyle = solidColor
  ctx.fillRect(0, 0, W, H)

  switch (mode) {
    case 'blur-extend':
      if (img) renderBlurExtend(ctx, img, W, H, settings.blurStrength)
      break
    case 'smart':
      renderSmartFill(ctx, img, W, H, settings, solidColor)
      break
    case 'gradient':
      renderGradient(ctx, img, W, H, settings)
      break
  }

  return c.toDataURL('image/jpeg', 0.92)
}

// ─── Hook ────────────────────────────────────────────────────────────────────

interface UseSmartBackgroundOptions {
  mode: BackgroundMode
  /** Source URL to sample colors / blur from. May be null if no image layer. */
  imageSrc: string | null
  canvasWidth: number
  canvasHeight: number
  settings: BackgroundSettings
  solidColor: string
}

interface UseSmartBackgroundResult {
  /** CSS backgroundImage value, e.g. `url("data:image/jpeg;base64,…")` or null */
  backgroundImageCss: string | null
  /** True while the image is loading or the offscreen canvas is rendering */
  computing: boolean
}

export function useSmartBackground({
  mode,
  imageSrc,
  canvasWidth,
  canvasHeight,
  settings,
  solidColor,
}: UseSmartBackgroundOptions): UseSmartBackgroundResult {
  const [result, setResult] = useState<string | null>(null)
  const [computing, setComputing] = useState(false)
  const prevKey = useRef('')

  useEffect(() => {
    // Cheap identity key — skip re-render if nothing relevant changed
    const key = `${mode}|${imageSrc}|${canvasWidth}x${canvasHeight}|${settings.blurStrength}|${settings.blendStrength}|${settings.gradientAngle}|${settings.autoColors}|${JSON.stringify(settings.gradientStops)}|${solidColor}`
    if (key === prevKey.current) return
    prevKey.current = key

    if (mode === 'solid' || mode === 'transparent') {
      setResult(null)
      setComputing(false)
      return
    }

    setComputing(true)

    if (!imageSrc) {
      // No image to sample from — still render gradient with user stops
      const dataUrl = renderBackgroundToDataUrl(mode, null, canvasWidth, canvasHeight, settings, solidColor)
      setResult(dataUrl)
      setComputing(false)
      return
    }

    const img = new window.Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      try {
        const dataUrl = renderBackgroundToDataUrl(mode, img, canvasWidth, canvasHeight, settings, solidColor)
        setResult(dataUrl)
      } catch (err) {
        console.error('[smart-background] render failed', err)
        setResult(null)
      } finally {
        setComputing(false)
      }
    }
    img.onerror = () => {
      setResult(null)
      setComputing(false)
    }
    img.src = imageSrc
  }, [mode, imageSrc, canvasWidth, canvasHeight, settings, solidColor])

  return {
    backgroundImageCss: result ? `url("${result}")` : null,
    computing,
  }
}