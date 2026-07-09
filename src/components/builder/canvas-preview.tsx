'use client'

import { useRef, useCallback } from 'react'
import { useBuilderStore } from '@/stores/builder-store'
import {
  Layer, TextLayer, ImageLayer, RectangleLayer, BadgeLayer,
  LogoLayer, OverlayLayer, StickerLayer, resolveVariables,
  DEFAULT_BACKGROUND_SETTINGS, DEFAULT_PRODUCT_LAYER_SETTINGS, PRODUCT_LAYER_ID,
} from '@/types/template'
import { useSmartBackground } from './smart-background'
import { useTransparentPreview } from './use-transparent-preview'
import { useExtendPreview } from './use-extend-preview'
import { useProductBounds } from './use-product-bounds'
import { useBackgroundReconstructionPreview } from './use-background-reconstruction-preview'
import { ProductPositioningGuide } from './product-positioning-guide'
import {
  placementToProductLayerSettings,
  calculatePlacement,
  computeClassificationSignals,
  classifyShotType,
  type ProductBounds,
  type HeadSpacePlacement,
} from '@/lib/product-positioning-shared'
import type { ProductPositioningSettings, ShotType } from '@/types/template'
import { Loader2, Sparkles, Wand2 } from 'lucide-react'

const MAX_W = 580
const MAX_H = 680

const SAMPLE_PRODUCT = {
  title: 'Sample Product',
  price: 1499,
  compare_at_price: 1999 as number | null,
  vendor: 'Brand' as string | null,
  product_type: 'Apparel' as string | null,
  imageUrl: null as string | null,
}

type DragKind =
  | { mode: 'move' }
  | { mode: 'resize'; corner: 'nw' | 'ne' | 'sw' | 'se' }

interface BoxRect { x: number; y: number; width: number; height: number }

/**
 * Shared canvas drag/resize handler (percentage-space, live streaming).
 * Used by both regular layers (LayerRenderer) and the manual product layer.
 * `proportional` locks aspect ratio on corner-resize so the product cutout is
 * never stretched/distorted — regular layers pass it false for free resize.
 */
function beginBoxDrag(
  e: React.MouseEvent,
  opts: {
    canvasEl: HTMLDivElement | null
    box: BoxRect
    kind: DragKind
    proportional?: boolean
    onStart?: () => void
    onChange: (updates: Partial<BoxRect>) => void
  }
) {
  e.stopPropagation()
  e.preventDefault()
  opts.onStart?.()
  const { canvasEl, box, kind, proportional, onChange } = opts
  if (!canvasEl) return
  const rect = canvasEl.getBoundingClientRect()
  const startX = e.clientX, startY = e.clientY
  const orig = { ...box }
  const toPctX = (px: number) => (px / rect.width) * 100
  const toPctY = (px: number) => (px / rect.height) * 100
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

  function onMove(ev: MouseEvent) {
    const dx = toPctX(ev.clientX - startX)
    const dy = toPctY(ev.clientY - startY)

    if (kind.mode === 'move') {
      onChange({
        x: clamp(orig.x + dx, 0, 100 - orig.width),
        y: clamp(orig.y + dy, 0, 100 - orig.height),
      })
      return
    }

    if (proportional) {
      // Uniform scale anchored at the opposite corner, aspect preserved in
      // canvas-percentage space (keeps the on-screen box shape constant).
      const aspect = orig.width / orig.height
      const outwardDx = kind.corner.includes('e') ? dx : kind.corner.includes('w') ? -dx : 0
      const maxW = kind.corner.includes('w') ? orig.x + orig.width : 100 - orig.x
      const maxH = kind.corner.includes('n') ? orig.y + orig.height : 100 - orig.y
      let width = clamp(orig.width + outwardDx, 2, Math.min(maxW, maxH * aspect))
      let height = width / aspect
      const x = kind.corner.includes('w') ? orig.x + orig.width - width : orig.x
      const y = kind.corner.includes('n') ? orig.y + orig.height - height : orig.y
      onChange({ x, y, width, height })
      return
    }

    let { x, y, width, height } = orig
    if (kind.corner.includes('e')) width = clamp(orig.width + dx, 2, 100 - orig.x)
    if (kind.corner.includes('s')) height = clamp(orig.height + dy, 2, 100 - orig.y)
    if (kind.corner.includes('w')) {
      width = clamp(orig.width - dx, 2, orig.x + orig.width)
      x = clamp(orig.x + dx, 0, orig.x + orig.width - 2)
    }
    if (kind.corner.includes('n')) {
      height = clamp(orig.height - dy, 2, orig.y + orig.height)
      y = clamp(orig.y + dy, 0, orig.y + orig.height - 2)
    }
    onChange({ x, y, width, height })
  }
  function onUp() {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

/** Rotate handle: angle from box center to pointer (+90 so a straight-up handle = 0°). */
function beginRotate(
  e: React.MouseEvent,
  opts: { canvasEl: HTMLDivElement | null; box: BoxRect; onStart?: () => void; onChange: (deg: number) => void }
) {
  e.stopPropagation()
  e.preventDefault()
  opts.onStart?.()
  const { canvasEl, box, onChange } = opts
  if (!canvasEl) return
  const rect = canvasEl.getBoundingClientRect()
  const cx = rect.left + ((box.x + box.width / 2) / 100) * rect.width
  const cy = rect.top + ((box.y + box.height / 2) / 100) * rect.height
  function onMove(ev: MouseEvent) {
    const deg = Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180 / Math.PI + 90
    onChange(Math.round(deg))
  }
  function onUp() {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

// ─── AI Extend Image Layer Preview ───────────────────────────────────────────
// Separate component so it can use hooks (rules of hooks: no hooks in callbacks
// or switch cases). Shows live generative-fill preview when objectFit='ai_extend'.

function AiExtendImageLayer({
  imageUrl,
  storeId,
  targetWidth,
  targetHeight,
}: {
  imageUrl: string | null
  storeId: string | null
  targetWidth: number
  targetHeight: number
}) {
  const { extendedUrl, loading, error, retry } = useExtendPreview(
    imageUrl,
    targetWidth,
    targetHeight,
    storeId,
    Boolean(imageUrl && storeId)
  )

  if (loading) {
    return (
      <div style={{
        width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 6,
        background: 'rgba(0,0,0,0.04)',
      }}>
        <Loader2 style={{ width: 18, height: 18, color: 'var(--primary)', animation: 'spin 1s linear infinite' }} />
        <span style={{ fontSize: 10, color: '#6b7280' }}>AI filling canvas…</span>
      </div>
    )
  }

  if (error) {
    return (
      <div style={{
        width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 4, padding: 8,
        background: 'rgba(239,68,68,0.05)',
      }}>
        <Wand2 style={{ width: 14, height: 14, color: '#ef4444' }} />
        <span style={{ fontSize: 10, color: '#ef4444', textAlign: 'center' }}>{error}</span>
        <button
          onClick={retry}
          style={{ fontSize: 10, color: '#6b7280', textDecoration: 'underline', background: 'none', border: 'none', cursor: 'pointer' }}
        >
          Retry
        </button>
      </div>
    )
  }

  if (extendedUrl) {
    return (
      <img
        src={extendedUrl}
        alt=""
        draggable={false}
        style={{ width: '100%', height: '100%', objectFit: 'cover', pointerEvents: 'none' }}
      />
    )
  }

  // While waiting for first load, show original at half opacity
  if (imageUrl) {
    return (
      <img
        src={imageUrl}
        alt=""
        draggable={false}
        style={{ width: '100%', height: '100%', objectFit: 'contain', pointerEvents: 'none', opacity: 0.5 }}
      />
    )
  }

  return (
    <div style={{
      width: '100%', height: '100%', display: 'flex',
      alignItems: 'center', justifyContent: 'center', fontSize: 11, color: '#9ca3af',
    }}>
      AI Extend
    </div>
  )
}

// ─── Local (client-side) positioning compute ─────────────────────────────────
// Bounds are fetched ONCE per image (useProductBounds); everything else —
// classification + placement — is pure math from product-positioning-shared.ts,
// recomputed synchronously during render on every slider change. This is what
// makes the live preview instantaneous: zero API calls while dragging.
// Mirrors the server's resolveProductPositioning() decision flow exactly.

interface LocalPositioning {
  apply: boolean
  shotType: ShotType | null
  placement: HeadSpacePlacement | null
  wouldCrop: boolean
  aspectRatio: number | null
  coverageRatio: number | null
}

function computeLocalPositioning(
  bounds: ProductBounds | null,
  settings: ProductPositioningSettings | undefined,
  boxW: number,
  boxH: number
): LocalPositioning | null {
  if (!bounds || !settings?.enabled || !boxW || !boxH) return null

  const signals = computeClassificationSignals(bounds)
  const shotType = classifyShotType(signals)
  const base = { shotType, aspectRatio: signals.aspectRatio, coverageRatio: signals.coverageRatio }

  if (!settings.applyToShotTypes.includes(shotType)) {
    return { ...base, apply: false, placement: null, wouldCrop: false }
  }

  const { placement, wouldCrop } = calculatePlacement(bounds, boxW, boxH, settings)
  if (wouldCrop) {
    return { ...base, apply: false, placement: null, wouldCrop: true }
  }
  return { ...base, apply: true, placement, wouldCrop: false }
}

// ─── Product Positioning Image Layer Preview (standard mode) ─────────────────
// Live-previews the actual computed reposition (move + scale within the
// layer's own box, blurred backdrop filling any gap) — matches what the
// server compositor now does for standard-mode templates.

function PositionedProductImageLayer({
  imageUrl,
  storeId,
  positioningSettings,
  boxPixelW,
  boxPixelH,
  fallbackObjectFit,
}: {
  imageUrl: string | null
  storeId: string | null
  positioningSettings: ProductPositioningSettings
  boxPixelW: number
  boxPixelH: number
  fallbackObjectFit: 'cover' | 'contain' | 'fill'
}) {
  // One network fetch per image; placement below is instant local math.
  const { bounds } = useProductBounds(imageUrl, storeId, Boolean(imageUrl && storeId))
  const result = computeLocalPositioning(bounds, positioningSettings, Math.round(boxPixelW), Math.round(boxPixelH))

  if (!imageUrl) {
    return (
      <div style={{
        width: '100%', height: '100%', display: 'flex', alignItems: 'center',
        justifyContent: 'center', fontSize: 11, color: '#9ca3af', pointerEvents: 'none',
      }}>
        Product Image
      </div>
    )
  }

  // No placement yet (loading / bypassed / not applicable) — show the plain
  // image with its normal fit so there's no flicker/empty state.
  if (!result?.apply || !result.placement) {
    return (
      <img
        src={imageUrl}
        alt=""
        draggable={false}
        style={{ width: '100%', height: '100%', objectFit: fallbackObjectFit, pointerEvents: 'none' }}
      />
    )
  }

  const { imgX, imgY, renderedW, renderedH } = result.placement
  const pctX = (v: number) => `${(v / boxPixelW) * 100}%`
  const pctY = (v: number) => `${(v / boxPixelH) * 100}%`

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
      {/* Blurred backdrop — same photo, fills any gap left by the reposition */}
      <img
        src={imageUrl}
        alt=""
        draggable={false}
        style={{
          position: 'absolute', inset: 0, width: '100%', height: '100%',
          objectFit: 'cover', filter: 'blur(20px) saturate(1.1) brightness(0.95)',
          transform: 'scale(1.15)', pointerEvents: 'none',
        }}
      />
      {/* Sharp repositioned image at the exact computed placement */}
      <img
        src={imageUrl}
        alt=""
        draggable={false}
        style={{
          position: 'absolute',
          left: pctX(imgX), top: pctY(imgY),
          width: pctX(renderedW), height: pctY(renderedH),
          objectFit: 'fill', pointerEvents: 'none',
        }}
      />
    </div>
  )
}

// ─── Layer Renderer ───────────────────────────────────────────────────────────

function LayerRenderer({ layer, selected, scaleX, product, canvasEl, onSelect, onChange, positioningSettings, storeId, cW, cH, isAiMode }: {
  layer: Layer
  selected: boolean
  scaleX: number
  product: typeof SAMPLE_PRODUCT
  canvasEl: HTMLDivElement | null
  onSelect: () => void
  onChange: (updates: Partial<Layer>) => void
  positioningSettings: import('@/types/template').ProductPositioningSettings | undefined
  storeId: string | null
  cW: number
  cH: number
  isAiMode: boolean
}) {
  const startDrag = useCallback((e: React.MouseEvent, kind: DragKind) => {
    beginBoxDrag(e, {
      canvasEl,
      box: { x: layer.x, y: layer.y, width: layer.width, height: layer.height },
      kind,
      onStart: onSelect,
      onChange: (updates) => onChange(updates as Partial<Layer>),
    })
  }, [layer.x, layer.y, layer.width, layer.height, canvasEl, onChange, onSelect])

  const style: React.CSSProperties = {
    position: 'absolute',
    left: `${layer.x}%`,
    top: `${layer.y}%`,
    width: `${layer.width}%`,
    height: `${layer.height}%`,
    transform: `rotate(${layer.rotation}deg)`,
    opacity: layer.opacity,
    zIndex: layer.zIndex + 1,
    cursor: 'move',
    boxSizing: 'border-box',
    outline: selected ? '2px solid #6366f1' : 'none',
    outlineOffset: '1px',
  }

  const handles = selected ? (['nw', 'ne', 'sw', 'se'] as const).map(c => (
    <div key={c} onMouseDown={(e) => startDrag(e, { mode: 'resize', corner: c })}
      style={{
        position: 'absolute', width: 10, height: 10, background: '#fff',
        border: '2px solid #6366f1', borderRadius: 2, zIndex: 9999,
        cursor: c === 'nw' || c === 'se' ? 'nwse-resize' : 'nesw-resize',
        top: c.includes('n') ? -5 : undefined,
        bottom: c.includes('s') ? -5 : undefined,
        left: c.includes('w') ? -5 : undefined,
        right: c.includes('e') ? -5 : undefined,
      }} />
  )) : null

  const wrap = (inner: React.ReactNode, extra?: React.CSSProperties) => (
    <div style={{ ...style, ...extra }} onMouseDown={(e) => startDrag(e, { mode: 'move' })}>
      {inner}
      {handles}
    </div>
  )

  switch (layer.type) {
    case 'rectangle': {
      const l = layer as RectangleLayer
      return wrap(null, {
        backgroundColor: l.backgroundColor,
        borderRadius: l.borderRadius,
        border: l.borderWidth > 0 ? `${l.borderWidth}px solid ${l.borderColor}` : 'none',
      })
    }

    case 'text': {
      const l = layer as TextLayer
      return wrap(
        <span style={{ pointerEvents: 'none', width: '100%' }}>{resolveVariables(l.content, product)}</span>,
        {
          display: 'flex', alignItems: 'center',
          justifyContent: l.textAlign === 'center' ? 'center' : l.textAlign === 'right' ? 'flex-end' : 'flex-start',
          fontSize: l.fontSize * scaleX, fontFamily: l.fontFamily, fontWeight: l.fontWeight,
          color: l.color, backgroundColor: l.backgroundColor || undefined, borderRadius: l.borderRadius,
          padding: `${l.paddingY * scaleX}px ${l.paddingX * scaleX}px`, textAlign: l.textAlign,
          overflow: 'hidden', lineHeight: 1.2, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        }
      )
    }

    case 'image': {
      const l = layer as ImageLayer
      const isProductImage = l.src === '{{product_image}}'
      const realSrc = isProductImage ? product.imageUrl : l.src

      // Product Positioning (standard mode): live-preview the actual computed
      // reposition, matching what the server compositor now does.
      if (!isAiMode && isProductImage && positioningSettings?.enabled && product.imageUrl) {
        const boxPixelW = (layer.width / 100) * cW
        const boxPixelH = (layer.height / 100) * cH
        return wrap(
          <PositionedProductImageLayer
            imageUrl={product.imageUrl}
            storeId={storeId}
            positioningSettings={positioningSettings}
            boxPixelW={boxPixelW}
            boxPixelH={boxPixelH}
            fallbackObjectFit={l.objectFit === 'ai_extend' ? 'contain' : l.objectFit}
          />,
          { borderRadius: l.borderRadius, overflow: 'hidden' }
        )
      }

      // AI Extend mode: use the dedicated component which has its own hook
      if (l.objectFit === 'ai_extend' && isProductImage) {
        const canvasW = canvasEl?.offsetWidth ?? 1080
        const canvasH = canvasEl?.offsetHeight ?? 1080
        const targetW = Math.round((layer.width / 100) * canvasW)
        const targetH = Math.round((layer.height / 100) * canvasH)
        return wrap(
          <AiExtendImageLayer
            imageUrl={product.imageUrl}
            storeId={storeId}
            targetWidth={targetW}
            targetHeight={targetH}
          />,
          { borderRadius: l.borderRadius, overflow: 'hidden' }
        )
      }

      return wrap(
        realSrc ? (
          <img
            src={realSrc}
            alt=""
            draggable={false}
            style={{
              width: '100%', height: '100%',
              objectFit: l.objectFit === 'ai_extend' ? 'contain' : l.objectFit,
              pointerEvents: 'none',
            }}
          />
        ) : (
          <div style={{
            width: '100%', height: '100%', display: 'flex', alignItems: 'center',
            justifyContent: 'center', fontSize: 11, color: '#9ca3af', pointerEvents: 'none',
          }}>
            Product Image
          </div>
        ),
        { borderRadius: l.borderRadius, overflow: 'hidden', backgroundColor: realSrc ? undefined : '#e5e7eb' }
      )
    }

    case 'overlay': {
      const l = layer as OverlayLayer
      return wrap(
        <img src={l.src} alt="" draggable={false}
          style={{ width: '100%', height: '100%', objectFit: l.objectFit, pointerEvents: 'none' }} />,
        { overflow: 'hidden' }
      )
    }

    case 'logo':
    case 'sticker': {
      const l = layer as LogoLayer | StickerLayer
      return wrap(
        l.src ? (
          <img src={l.src} alt="" draggable={false}
            style={{ width: '100%', height: '100%', objectFit: l.objectFit, pointerEvents: 'none' }} />
        ) : (
          <div style={{
            width: '100%', height: '100%', display: 'flex', alignItems: 'center',
            justifyContent: 'center', fontSize: 11, color: '#9ca3af', pointerEvents: 'none',
          }}>
            {layer.type === 'sticker' ? 'Sticker' : 'Logo'}
          </div>
        ),
        { borderRadius: l.borderRadius, overflow: 'hidden' }
      )
    }

    case 'badge': {
      const l = layer as BadgeLayer
      return wrap(
        <span style={{ pointerEvents: 'none' }}>{resolveVariables(l.content, product)}</span>,
        {
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          backgroundColor: l.backgroundColor, color: l.color, fontSize: l.fontSize * scaleX,
          fontWeight: l.fontWeight, borderRadius: l.shape === 'circle' ? '50%' : l.borderRadius,
          overflow: 'hidden', textAlign: 'center',
        }
      )
    }

    default:
      return null
  }
}

// ─── AI Product Layer Preview ────────────────────────────────────────────────

function ProductLayerPreview({
  imageUrl,
  storeId,
  enabled,
  settings,
  scaleX,
}: {
  imageUrl: string | null
  storeId: string | null
  enabled: boolean
  settings: typeof DEFAULT_PRODUCT_LAYER_SETTINGS
  scaleX: number
}) {
  const { transparentUrl, loading, error, retry } = useTransparentPreview(imageUrl, storeId, enabled)

  if (!enabled) return null

  const pad = settings.padding / 100
  const style: React.CSSProperties = {
    position: 'absolute',
    left: `${settings.x + (settings.width * pad) / 2}%`,
    top: `${settings.y + (settings.height * pad) / 2}%`,
    width: `${settings.width * (1 - pad)}%`,
    height: `${settings.height * (1 - pad)}%`,
    transform: `rotate(${settings.rotation}deg) scaleX(${settings.flipH ? -1 : 1}) scaleY(${settings.flipV ? -1 : 1})`,
    opacity: settings.opacity,
    zIndex: settings.zIndex + 1,
    pointerEvents: 'none',
  }

  const filters: string[] = []
  if (settings.shadow) {
    filters.push(`drop-shadow(${settings.shadowOffsetX}px ${settings.shadowOffsetY}px ${settings.shadowBlur}px ${settings.shadowColor})`)
  }
  if (settings.glow) {
    filters.push(`drop-shadow(0 0 ${settings.glowBlur}px ${settings.glowColor})`)
  }

  if (!imageUrl) {
    return (
      <div style={style} className="flex items-center justify-center bg-muted/40 rounded-lg border border-dashed">
        <p className="text-xs text-muted-foreground px-2 text-center">Select a preview product to see the AI result</p>
      </div>
    )
  }

  if (loading) {
    return (
      <div style={style} className="flex flex-col items-center justify-center gap-2 bg-muted/40 rounded-lg">
        <Loader2 className="h-5 w-5 animate-spin text-primary" />
        <p className="text-xs text-muted-foreground">Removing background…</p>
      </div>
    )
  }

  if (error) {
    return (
      <div style={style} className="flex flex-col items-center justify-center gap-1.5 bg-destructive/5 rounded-lg border border-destructive/30 p-2">
        <p className="text-xs text-destructive text-center">{error}</p>
        <button onClick={retry} className="text-xs underline text-muted-foreground">Retry</button>
      </div>
    )
  }

  if (!transparentUrl) return null

  return (
    <img
      src={transparentUrl}
      alt="Product (background removed)"
      draggable={false}
      style={{
        ...style,
        objectFit: settings.objectFit,
        filter: filters.length > 0 ? filters.join(' ') : undefined,
      }}
    />
  )
}

// ─── Product Positioning — live preview wrapper (ai_product mode) ────────────
// Recomputes the real placement (via the server's product-positioning module,
// since bounds detection needs @napi-rs/canvas) and overrides the settings fed
// into ProductLayerPreview, so the editor shows the actual computed position
// rather than a static guideline.

function AiModePositioning({
  imageUrl,
  storeId,
  enabled,
  settings,
  positioningSettings,
  scaleX,
  canvasW,
  canvasH,
  canvasEl,
}: {
  imageUrl: string | null
  storeId: string | null
  enabled: boolean
  settings: typeof DEFAULT_PRODUCT_LAYER_SETTINGS
  positioningSettings: ProductPositioningSettings | undefined
  scaleX: number
  canvasW: number
  canvasH: number
  canvasEl: HTMLDivElement | null
}) {
  const { selectedLayerId, selectLayer, setProductLayerSettings } = useBuilderStore()

  const positioningOn = Boolean(positioningSettings?.enabled)
  // Manual (Canva-style) editing is the ai_product path when auto-positioning
  // is OFF. When positioning is ON, the legacy render-time auto-fit owns the
  // product (unchanged behavior) and manual drag is disabled.
  const manualMode = enabled && !positioningOn
  const selected = selectedLayerId === PRODUCT_LAYER_ID
  const locked = Boolean(settings.locked)
  const interactive = manualMode && !locked && Boolean(imageUrl)

  // Bounds are fetched once per image (against the SAME transparent cutout the
  // real generation pipeline uses). In auto mode this drives the live placement;
  // in manual mode it powers the on-demand "Auto-arrange" button. Either way
  // it's one fetch per image — everything downstream is instant local math.
  const { transparentUrl } = useTransparentPreview(imageUrl, storeId, enabled)
  const { bounds, error } = useProductBounds(
    transparentUrl, storeId, enabled && (positioningOn || interactive)
  )
  const result = computeLocalPositioning(bounds, positioningSettings, canvasW, canvasH)

  const effectiveSettings = (result?.apply && result.placement)
    ? placementToProductLayerSettings(result.placement, canvasW, canvasH, settings)
    : settings

  const SHOT_LABELS: Record<ShotType, string> = {
    full_body: 'Full Body', half_body: 'Half Body', close_up: 'Close-up',
    detail: 'Detail', flat_lay: 'Flat Lay', accessory: 'Accessory',
  }

  // Detected content box in canvas percentages — for the guide-mode
  // bounding-box visualization (editor-only, never exported).
  const contentBox = (result?.apply && result.placement && bounds) ? (() => {
    const { imgX, imgY, scale } = result.placement!
    return {
      left:   ((imgX + bounds.left * scale) / canvasW) * 100,
      top:    ((imgY + bounds.top * scale) / canvasH) * 100,
      width:  (((bounds.right - bounds.left) * scale) / canvasW) * 100,
      height: (((bounds.bottom - bounds.top) * scale) / canvasH) * 100,
    }
  })() : null

  const box: BoxRect = { x: settings.x, y: settings.y, width: settings.width, height: settings.height }

  function autoArrange() {
    if (!bounds) return
    const { placement, wouldCrop } = calculatePlacement(bounds, canvasW, canvasH, positioningSettings ?? {
      headSpacePx: 120, leftMarginPx: 40, rightMarginPx: 40, bottomMarginPx: 40,
      autoCenterHorizontally: true, scaleMode: 'smart_fit', maxUpscale: 1.5,
    } as ProductPositioningSettings)
    if (wouldCrop) return
    setProductLayerSettings(placementToProductLayerSettings(placement, canvasW, canvasH, settings))
  }

  return (
    <>
      <ProductLayerPreview
        imageUrl={imageUrl}
        storeId={storeId}
        enabled={enabled}
        settings={effectiveSettings}
        scaleX={scaleX}
      />

      {/* ── Manual (Canva-style) interaction overlay ─────────────────────────
          Sits at the raw settings box, above the (pointer-events:none) visual.
          Drag to move, corner handles to proportionally resize, top handle to
          rotate — all pure store writes (instant, no API). Only in manual mode. */}
      {interactive && (
        <div
          onMouseDown={(e) => beginBoxDrag(e, {
            canvasEl, box, kind: { mode: 'move' },
            onStart: () => selectLayer(PRODUCT_LAYER_ID),
            onChange: (u) => setProductLayerSettings(u),
          })}
          style={{
            position: 'absolute',
            left: `${settings.x}%`, top: `${settings.y}%`,
            width: `${settings.width}%`, height: `${settings.height}%`,
            transform: `rotate(${settings.rotation}deg)`,
            zIndex: settings.zIndex + 2,
            cursor: 'move',
            outline: selected ? '2px solid #6366f1' : '1px dashed rgba(99,102,241,0.5)',
            outlineOffset: 1,
            background: 'transparent',
          }}
        >
          {selected && (['nw', 'ne', 'sw', 'se'] as const).map(c => (
            <div key={c} onMouseDown={(e) => beginBoxDrag(e, {
              canvasEl, box, kind: { mode: 'resize', corner: c }, proportional: true,
              onChange: (u) => setProductLayerSettings(u),
            })}
              style={{
                position: 'absolute', width: 10, height: 10, background: '#fff',
                border: '2px solid #6366f1', borderRadius: 2, zIndex: 10000,
                cursor: c === 'nw' || c === 'se' ? 'nwse-resize' : 'nesw-resize',
                top: c.includes('n') ? -5 : undefined,
                bottom: c.includes('s') ? -5 : undefined,
                left: c.includes('w') ? -5 : undefined,
                right: c.includes('e') ? -5 : undefined,
              }} />
          ))}
          {selected && (
            <div
              onMouseDown={(e) => beginRotate(e, { canvasEl, box, onChange: (deg) => setProductLayerSettings({ rotation: deg }) })}
              style={{
                position: 'absolute', top: -24, left: '50%', width: 12, height: 12,
                marginLeft: -6, background: '#fff', border: '2px solid #6366f1',
                borderRadius: '50%', cursor: 'grab', zIndex: 10000,
              }}
              title="Rotate"
            />
          )}
        </div>
      )}

      {/* ── Contextual toolbar (Canva-style) — Auto-arrange / Flip / Lock ──── */}
      {manualMode && selected && (
        <div
          style={{
            position: 'absolute',
            left: `${settings.x}%`, top: `calc(${settings.y}% - 34px)`,
            zIndex: 10001, display: 'flex', gap: 4, padding: 4,
            background: 'rgba(255,255,255,0.96)', borderRadius: 8,
            border: '1px solid rgba(0,0,0,0.08)', boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
            whiteSpace: 'nowrap',
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <ToolbarButton label="✨ Auto-arrange" onClick={autoArrange} disabled={!bounds} primary />
          <ToolbarButton label="Flip H" active={settings.flipH} onClick={() => setProductLayerSettings({ flipH: !settings.flipH })} />
          <ToolbarButton label="Flip V" active={settings.flipV} onClick={() => setProductLayerSettings({ flipV: !settings.flipV })} />
          <ToolbarButton label={locked ? '🔒' : '🔓'} onClick={() => setProductLayerSettings({ locked: !locked })} />
        </div>
      )}

      {/* Locked-but-manual: still allow selecting to unlock via toolbar */}
      {manualMode && locked && (
        <div
          onMouseDown={(e) => { e.stopPropagation(); selectLayer(PRODUCT_LAYER_ID) }}
          style={{
            position: 'absolute',
            left: `${settings.x}%`, top: `${settings.y}%`,
            width: `${settings.width}%`, height: `${settings.height}%`,
            zIndex: settings.zIndex + 2, cursor: 'pointer',
            outline: selected ? '2px solid #6366f1' : 'none',
          }}
        />
      )}

      {/* Detected bounding box — visible only with guides on, never exported */}
      {positioningOn && positioningSettings?.showGuide && contentBox && (
        <div
          style={{
            position: 'absolute',
            left: `${contentBox.left}%`, top: `${contentBox.top}%`,
            width: `${contentBox.width}%`, height: `${contentBox.height}%`,
            border: '1px dashed rgba(16, 185, 129, 0.8)',
            zIndex: 9998, pointerEvents: 'none',
          }}
          aria-hidden="true"
        />
      )}

      {/* Auto-position indicator (auto mode): what was detected + whether applied */}
      {positioningOn && (
        <div
          style={{
            position: 'absolute', left: 6, bottom: 6, zIndex: 9999,
            fontSize: 10, lineHeight: 1.3,
            background: 'rgba(255,255,255,0.88)', color: '#111', padding: '2px 8px',
            borderRadius: 999, pointerEvents: 'none', border: '1px solid rgba(0,0,0,0.08)',
            boxShadow: '0 1px 4px rgba(0,0,0,0.12)', whiteSpace: 'nowrap',
          }}
        >
          {error
            ? <span style={{ color: '#dc2626' }}>Detection failed — using manual layout</span>
            : !bounds
              ? 'Detecting product…'
              : result?.apply
                ? <>Detected: <b>{SHOT_LABELS[result.shotType!]}</b> · auto-aligned</>
                : <>Detected: <b>{result?.shotType ? SHOT_LABELS[result.shotType] : '—'}</b> · skipped (not in Shot Types)</>}
        </div>
      )}
    </>
  )
}

function ToolbarButton({ label, onClick, active, primary, disabled }: {
  label: string; onClick: () => void; active?: boolean; primary?: boolean; disabled?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        fontSize: 11, lineHeight: 1, padding: '5px 8px', borderRadius: 6, cursor: disabled ? 'default' : 'pointer',
        border: '1px solid ' + (active ? '#6366f1' : 'rgba(0,0,0,0.12)'),
        background: primary ? '#6366f1' : active ? 'rgba(99,102,241,0.1)' : '#fff',
        color: primary ? '#fff' : active ? '#4f46e5' : '#111',
        opacity: disabled ? 0.5 : 1, fontWeight: 500,
      }}
    >
      {label}
    </button>
  )
}

// ─── Canvas Preview ───────────────────────────────────────────────────────────

export function CanvasPreview({ storeId }: { storeId?: string | null } = {}) {
  const { canvasData, selectedLayerId, selectLayer, updateLayer, previewProduct } = useBuilderStore()
  const canvasRef = useRef<HTMLDivElement>(null)
  const product = previewProduct ?? SAMPLE_PRODUCT

  const { width: cW, height: cH } = canvasData
  const scale = Math.min(MAX_W / cW, MAX_H / cH, 1)
  const displayW = Math.round(cW * scale)
  const displayH = Math.round(cH * scale)
  const scaleX = displayW / 1000

  const isAiMode = canvasData.templateMode === 'ai_product'
  const productLayerSettings = canvasData.productLayerSettings ?? DEFAULT_PRODUCT_LAYER_SETTINGS

  const bgSettings = canvasData.backgroundSettings ?? DEFAULT_BACKGROUND_SETTINGS
  const sampleSrc = (() => {
    if (bgSettings.mode === 'solid' || bgSettings.mode === 'transparent') return null
    if (isAiMode) return null
    if (product.imageUrl) return product.imageUrl
    const imgLayer = canvasData.layers.find(
      l => (l.type === 'image' || l.type === 'overlay') &&
        (l as any).src &&
        (l as any).src !== '{{product_image}}'
    )
    return imgLayer ? (imgLayer as any).src : null
  })()

  const { backgroundImageCss } = useSmartBackground({
    mode: bgSettings.mode,
    imageSrc: sampleSrc,
    canvasWidth: displayW,
    canvasHeight: displayH,
    settings: bgSettings,
    solidColor: canvasData.backgroundColor,
  })

  // 'original' mode: reconstruct the product's own studio backdrop (product
  // region AI-inpainted) instead of any synthetic background. Only runs when
  // explicitly opted into — useSmartBackground doesn't know this mode and
  // no-ops for it (sampleSrc is already null in ai_product mode above), so
  // this is a fully separate, additive source, resolved the same
  // cache-then-generate way as the transparent cutout itself.
  const useOriginalBackground = isAiMode && bgSettings.mode === 'original'
  const { transparentUrl: transparentUrlForBg } = useTransparentPreview(
    product.imageUrl, storeId ?? null, useOriginalBackground
  )
  const { backgroundUrl: reconstructedBackgroundUrl, loading: reconstructingBackground, error: reconstructionError } =
    useBackgroundReconstructionPreview(product.imageUrl, transparentUrlForBg, storeId ?? null, useOriginalBackground)

  const transparentBg = bgSettings.mode === 'transparent'
    ? 'repeating-conic-gradient(#ccc 0% 25%, #fff 0% 50%) 0 0 / 16px 16px'
    : undefined

  // Once background removal succeeds, the transparent cutout (rendered via
  // AiModePositioning below) is the ONLY visual representation of the
  // product — an 'image'-type layer still pointing at '{{product_image}}'
  // (e.g. the default layer every new template starts with) would otherwise
  // show the ORIGINAL, non-transparent photo underneath it. Mirrors the same
  // exclusion in the server compositor.
  const isRawProductImageLayer = (l: Layer) =>
    l.type === 'image' && (l as any).src === '{{product_image}}'

  const sortedLayers = [...canvasData.layers]
    .filter(l => !(isAiMode && isRawProductImageLayer(l)))
    .sort((a, b) => a.zIndex - b.zIndex)
  const bgLayers = isAiMode
    ? sortedLayers.filter(l => l.zIndex < productLayerSettings.zIndex)
    : sortedLayers
  const fgLayers = isAiMode
    ? sortedLayers.filter(l => l.zIndex >= productLayerSettings.zIndex)
    : []

  function renderLayer(layer: Layer) {
    return (
      <LayerRenderer
        key={layer.id}
        layer={layer}
        product={product}
        canvasEl={canvasRef.current}
        scaleX={scaleX}
        selected={selectedLayerId === layer.id}
        onSelect={() => selectLayer(layer.id)}
        onChange={(updates) => updateLayer(layer.id, updates)}
        positioningSettings={canvasData.productPositioningSettings}
        storeId={storeId ?? null}
        cW={cW}
        cH={cH}
        isAiMode={isAiMode}
      />
    )
  }

  return (
    <div className="flex flex-col items-center gap-3">
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">{cW} × {cH}px</span>
        {isAiMode && (
          <span className="flex items-center gap-1 text-xs text-primary font-medium">
            <Sparkles className="h-3 w-3" />
            Live AI preview
          </span>
        )}
        {useOriginalBackground && reconstructingBackground && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            Reconstructing background…
          </span>
        )}
        {/* Temporary debug text — surfaces the real Cloudinary/API failure
            reason instead of silently falling back, so a blank/white
            background can be diagnosed from a screenshot. Remove once this
            is confirmed working end-to-end. */}
        {useOriginalBackground && !reconstructingBackground && (
          <span className="text-xs font-mono" style={{ color: reconstructionError ? '#dc2626' : '#16a34a' }}>
            {reconstructionError
              ? `bg-reconstruction ERROR: ${reconstructionError}`
              : reconstructedBackgroundUrl
                ? 'bg-reconstruction: OK'
                : 'bg-reconstruction: no result (check transparent cutout loaded)'}
          </span>
        )}
      </div>
      <div
        ref={(el) => {
          (canvasRef as any).current = el
          if (el) (el as any).__storeId = storeId ?? null
        }}
        style={{
          width: displayW, height: displayH,
          backgroundColor: bgSettings.mode === 'transparent' ? 'transparent' : canvasData.backgroundColor,
          backgroundImage: useOriginalBackground
            ? (reconstructedBackgroundUrl ? `url(${reconstructedBackgroundUrl})` : undefined)
            : (backgroundImageCss ?? (transparentBg ?? (canvasData.backgroundImageUrl ? `url(${canvasData.backgroundImageUrl})` : undefined))),
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          position: 'relative', overflow: 'hidden', flexShrink: 0,
          boxShadow: '0 4px 32px rgba(0,0,0,0.12)', borderRadius: 6, userSelect: 'none',
        }}
        onMouseDown={(e) => { if (e.target === e.currentTarget) selectLayer(null) }}
      >
        {bgLayers.map(renderLayer)}
        {isAiMode && (
          <AiModePositioning
            imageUrl={product.imageUrl}
            storeId={storeId ?? null}
            enabled={isAiMode}
            settings={productLayerSettings}
            positioningSettings={canvasData.productPositioningSettings}
            scaleX={scaleX}
            canvasW={cW}
            canvasH={cH}
            canvasEl={canvasRef.current}
          />
        )}
        {fgLayers.map(renderLayer)}
        {canvasData.productPositioningSettings?.enabled && (
          <ProductPositioningGuide
            settings={canvasData.productPositioningSettings}
            displayW={displayW}
            displayH={displayH}
            canvasW={cW}
            canvasH={cH}
          />
        )}
      </div>
    </div>
  )
}