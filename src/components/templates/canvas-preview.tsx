'use client'

import { useRef, useCallback } from 'react'
import { useBuilderStore } from '@/stores/builder-store'
import {
  Layer, TextLayer, ImageLayer, RectangleLayer, BadgeLayer, LogoLayer, OverlayLayer,
  resolveVariables,
} from '@/types/template'

const CANVAS_SIZE = 500 // display size in px; actual export is high-res
const SCALE = CANVAS_SIZE / 1000

function pct(v: number) { return `${v}%` }

// Sample product used when no real product is selected, so the editor never
// shows empty boxes / raw {{tokens}}.
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

function LayerRenderer({
  layer, selected, product, canvasEl, onSelect, onChange,
}: {
  layer: Layer
  selected: boolean
  product: typeof SAMPLE_PRODUCT
  canvasEl: HTMLDivElement | null
  onSelect: () => void
  onChange: (updates: Partial<Layer>) => void
}) {
  // Mouse drag / resize: convert pixel deltas into the layer's 0-100 percent
  // space so the numeric X/Y/W/H inputs and the canvas stay in sync.
  const startDrag = useCallback((e: React.MouseEvent, kind: DragKind) => {
    e.stopPropagation()
    e.preventDefault()
    onSelect()
    if (!canvasEl) return
    const rect = canvasEl.getBoundingClientRect()
    const startX = e.clientX
    const startY = e.clientY
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
    left: pct(layer.x),
    top: pct(layer.y),
    width: pct(layer.width),
    height: pct(layer.height),
    transform: `rotate(${layer.rotation}deg)`,
    opacity: layer.opacity,
    zIndex: layer.zIndex + 1,
    cursor: 'move',
    boxSizing: 'border-box',
    outline: selected ? '2px solid #6366f1' : 'none',
    outlineOffset: '1px',
  }

  const handles = selected ? (['nw', 'ne', 'sw', 'se'] as const).map(c => (
    <div
      key={c}
      onMouseDown={(e) => startDrag(e, { mode: 'resize', corner: c })}
      style={{
        position: 'absolute',
        width: 10, height: 10,
        background: '#fff',
        border: '2px solid #6366f1',
        borderRadius: 2,
        zIndex: 9999,
        cursor: c === 'nw' || c === 'se' ? 'nwse-resize' : 'nesw-resize',
        top: c.includes('n') ? -5 : undefined,
        bottom: c.includes('s') ? -5 : undefined,
        left: c.includes('w') ? -5 : undefined,
        right: c.includes('e') ? -5 : undefined,
      }}
    />
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
        <span style={{ pointerEvents: 'none', width: '100%' }}>
          {resolveVariables(l.content, product)}
        </span>,
        {
          display: 'flex',
          alignItems: 'center',
          justifyContent: l.textAlign === 'center' ? 'center' : l.textAlign === 'right' ? 'flex-end' : 'flex-start',
          fontSize: l.fontSize * SCALE,
          fontFamily: l.fontFamily,
          fontWeight: l.fontWeight,
          color: l.color,
          backgroundColor: l.backgroundColor || undefined,
          borderRadius: l.borderRadius,
          padding: `${l.paddingY * SCALE}px ${l.paddingX * SCALE}px`,
          textAlign: l.textAlign,
          overflow: 'hidden',
          lineHeight: 1.2,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }
      )
    }

    case 'image': {
      const l = layer as ImageLayer
      const isProductImage = l.src === '{{product_image}}'
      const realSrc = isProductImage ? product.imageUrl : l.src
      return wrap(
        realSrc ? (
          <img src={realSrc} alt="" draggable={false}
            style={{ width: '100%', height: '100%', objectFit: l.objectFit, pointerEvents: 'none' }} />
        ) : (
          <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center',
            justifyContent: 'center', fontSize: 11, color: '#9ca3af', pointerEvents: 'none' }}>
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
      const l = layer as LogoLayer
      return wrap(
        l.src ? (
          <img src={l.src} alt="" draggable={false}
            style={{ width: '100%', height: '100%', objectFit: l.objectFit, pointerEvents: 'none' }} />
        ) : (
          <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center',
            justifyContent: 'center', fontSize: 11, color: '#9ca3af', pointerEvents: 'none' }}>
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
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: l.backgroundColor,
          color: l.color,
          fontSize: l.fontSize * SCALE,
          fontWeight: l.fontWeight,
          borderRadius: l.shape === 'circle' ? '50%' : l.borderRadius,
          overflow: 'hidden',
          textAlign: 'center',
        }
      )
    }

    default:
      return null
  }
}

export function CanvasPreview() {
  const { canvasData, selectedLayerId, selectLayer, updateLayer, previewProduct } = useBuilderStore()
  const canvasRef = useRef<HTMLDivElement>(null)
  const product = previewProduct ?? SAMPLE_PRODUCT

  return (
    <div
      ref={canvasRef}
      style={{
        width: CANVAS_SIZE,
        height: CANVAS_SIZE,
        backgroundColor: canvasData.backgroundColor,
        backgroundImage: canvasData.backgroundImageUrl ? `url(${canvasData.backgroundImageUrl})` : undefined,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        position: 'relative',
        overflow: 'hidden',
        flexShrink: 0,
        boxShadow: '0 4px 32px rgba(0,0,0,0.12)',
        borderRadius: 8,
        userSelect: 'none',
      }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) selectLayer(null) }}
    >
      {[...canvasData.layers]
        .sort((a, b) => a.zIndex - b.zIndex)
        .map(layer => (
          <LayerRenderer
            key={layer.id}
            layer={layer}
            product={product}
            canvasEl={canvasRef.current}
            selected={selectedLayerId === layer.id}
            onSelect={() => selectLayer(layer.id)}
            onChange={(updates) => updateLayer(layer.id, updates)}
          />
        ))}
    </div>
  )
}