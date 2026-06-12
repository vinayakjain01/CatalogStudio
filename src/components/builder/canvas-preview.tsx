'use client'

import { useBuilderStore } from '@/stores/builder-store'
import { Layer, TextLayer, ImageLayer, RectangleLayer, BadgeLayer } from '@/types/template'
import { cn } from '@/lib/utils'

const CANVAS_SIZE = 500 // display size in px; actual export is 1000px
const SCALE = CANVAS_SIZE / 1000

function pct(v: number) { return `${v}%` }

function LayerRenderer({ layer, selected, onSelect }: {
  layer: Layer
  selected: boolean
  onSelect: () => void
}) {
  const style: React.CSSProperties = {
    position: 'absolute',
    left: pct(layer.x),
    top: pct(layer.y),
    width: pct(layer.width),
    height: pct(layer.height),
    transform: `rotate(${layer.rotation}deg)`,
    opacity: layer.opacity,
    zIndex: layer.zIndex + 1,
    cursor: 'pointer',
    boxSizing: 'border-box',
    outline: selected ? '2px solid #6366f1' : 'none',
    outlineOffset: '1px',
  }

  switch (layer.type) {
    case 'rectangle': {
      const l = layer as RectangleLayer
      return (
        <div
          style={{
            ...style,
            backgroundColor: l.backgroundColor,
            borderRadius: l.borderRadius,
            border: l.borderWidth > 0 ? `${l.borderWidth}px solid ${l.borderColor}` : 'none',
          }}
          onClick={onSelect}
        />
      )
    }

    case 'text': {
      const l = layer as TextLayer
      return (
        <div
          style={{
            ...style,
            display: 'flex',
            alignItems: 'center',
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
          }}
          onClick={onSelect}
        >
          {l.content}
        </div>
      )
    }

    case 'image': {
      const l = layer as ImageLayer
      const isProductImage = l.src === '{{product_image}}'
      return (
        <div
          style={{
            ...style,
            borderRadius: l.borderRadius,
            overflow: 'hidden',
            backgroundColor: isProductImage ? '#e5e7eb' : undefined,
          }}
          onClick={onSelect}
        >
          {isProductImage ? (
            <div className="w-full h-full flex items-center justify-center text-xs text-gray-400">
              Product Image
            </div>
          ) : (
            <img src={l.src} alt="" style={{ width: '100%', height: '100%', objectFit: l.objectFit }} />
          )}
        </div>
      )
    }

    case 'badge': {
      const l = layer as BadgeLayer
      return (
        <div
          style={{
            ...style,
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
          }}
          onClick={onSelect}
        >
          {l.content}
        </div>
      )
    }

    default:
      return null
  }
}

export function CanvasPreview() {
  const { canvasData, selectedLayerId, selectLayer } = useBuilderStore()

  return (
    <div
      style={{
        width: CANVAS_SIZE,
        height: CANVAS_SIZE,
        backgroundColor: canvasData.backgroundColor,
        backgroundImage: canvasData.backgroundImageUrl
          ? `url(${canvasData.backgroundImageUrl})`
          : undefined,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        position: 'relative',
        overflow: 'hidden',
        flexShrink: 0,
        boxShadow: '0 4px 32px rgba(0,0,0,0.12)',
        borderRadius: 8,
      }}
      onClick={() => selectLayer(null)}
    >
      {[...canvasData.layers]
        .sort((a, b) => a.zIndex - b.zIndex)
        .map(layer => (
          <LayerRenderer
            key={layer.id}
            layer={layer}
            selected={selectedLayerId === layer.id}
            onSelect={() => selectLayer(layer.id)}
          />
        ))}
    </div>
  )
}