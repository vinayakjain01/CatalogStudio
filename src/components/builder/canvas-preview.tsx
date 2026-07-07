'use client'

import { useRef, useCallback } from 'react'
import { useBuilderStore } from '@/stores/builder-store'
import {
  Layer, TextLayer, ImageLayer, RectangleLayer, BadgeLayer,
  LogoLayer, OverlayLayer, StickerLayer, resolveVariables,
  DEFAULT_BACKGROUND_SETTINGS, DEFAULT_PRODUCT_LAYER_SETTINGS,
} from '@/types/template'
import { useSmartBackground } from './smart-background'
import { useTransparentPreview } from './use-transparent-preview'
import { useExtendPreview } from './use-extend-preview'
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

// ─── Layer Renderer ───────────────────────────────────────────────────────────

function LayerRenderer({ layer, selected, scaleX, product, canvasEl, onSelect, onChange }: {
  layer: Layer
  selected: boolean
  scaleX: number
  product: typeof SAMPLE_PRODUCT
  canvasEl: HTMLDivElement | null
  onSelect: () => void
  onChange: (updates: Partial<Layer>) => void
}) {
  const startDrag = useCallback((e: React.MouseEvent, kind: DragKind) => {
    e.stopPropagation()
    e.preventDefault()
    onSelect()
    if (!canvasEl) return
    const rect = canvasEl.getBoundingClientRect()
    const startX = e.clientX, startY = e.clientY
    const orig = { x: layer.x, y: layer.y, width: layer.width, height: layer.height }
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
        } as Partial<Layer>)
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
      onChange({ x, y, width, height } as Partial<Layer>)
    }
    function onUp() {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
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

      // AI Extend mode: use the dedicated component which has its own hook
      if (l.objectFit === 'ai_extend' && isProductImage) {
        // Read storeId stored on the canvas DOM element
        const storeId = (canvasEl as any)?.__storeId ?? null
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
    transform: `rotate(${settings.rotation}deg)`,
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

  const transparentBg = bgSettings.mode === 'transparent'
    ? 'repeating-conic-gradient(#ccc 0% 25%, #fff 0% 50%) 0 0 / 16px 16px'
    : undefined

  const sortedLayers = [...canvasData.layers].sort((a, b) => a.zIndex - b.zIndex)
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
      </div>
      <div
        ref={(el) => {
          (canvasRef as any).current = el
          if (el) (el as any).__storeId = storeId ?? null
        }}
        style={{
          width: displayW, height: displayH,
          backgroundColor: bgSettings.mode === 'transparent' ? 'transparent' : canvasData.backgroundColor,
          backgroundImage: backgroundImageCss ?? (transparentBg ?? (canvasData.backgroundImageUrl ? `url(${canvasData.backgroundImageUrl})` : undefined)),
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          position: 'relative', overflow: 'hidden', flexShrink: 0,
          boxShadow: '0 4px 32px rgba(0,0,0,0.12)', borderRadius: 6, userSelect: 'none',
        }}
        onMouseDown={(e) => { if (e.target === e.currentTarget) selectLayer(null) }}
      >
        {bgLayers.map(renderLayer)}
        {isAiMode && (
          <ProductLayerPreview
            imageUrl={product.imageUrl}
            storeId={storeId ?? null}
            enabled={isAiMode}
            settings={productLayerSettings}
            scaleX={scaleX}
          />
        )}
        {fgLayers.map(renderLayer)}

        {/* Head Space guide overlay — visible only when head space is enabled */}
        {canvasData.headSpaceSettings?.enabled &&
          (canvasData.headSpaceSettings.showGuide ?? true) && (
            <HeadSpaceGuide
              settings={canvasData.headSpaceSettings}
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
// ─── Head Space Guide Overlay ─────────────────────────────────────────────────
// Rendered on top of the canvas preview when head space is enabled.
// Shows dashed guide lines for head space and margins so the user can see
// exactly how the alignment will work before generating.

import { HeadSpaceGuide } from './HeadSpaceGuide'