'use client'

import { useBuilderStore } from '@/stores/builder-store'
import { Layer, TextLayer, ImageLayer, RectangleLayer, BadgeLayer } from '@/types/template'
import { resolveVariables } from '@/types/template'

const MAX_W = 580
const MAX_H = 680

// Renders a layer using preview product data if available
function LayerRenderer({ layer, selected, canvasW, canvasH, previewProduct, onSelect }: {
  layer: Layer
  selected: boolean
  canvasW: number
  canvasH: number
  previewProduct: any | null
  onSelect: () => void
}) {
  const SCALE_X = canvasW / 1000
  const SCALE_Y = canvasH / 1000

  const style: React.CSSProperties = {
    position: 'absolute',
    left: `${layer.x}%`,
    top: `${layer.y}%`,
    width: `${layer.width}%`,
    height: `${layer.height}%`,
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
      // If preview product exists, show resolved variables; otherwise show raw template syntax
      const content = previewProduct
        ? resolveVariables(l.content, previewProduct)
        : l.content
      return (
        <div
          style={{
            ...style,
            display: 'flex',
            alignItems: 'center',
            fontSize: l.fontSize * SCALE_X,
            fontFamily: l.fontFamily,
            fontWeight: l.fontWeight,
            color: l.color,
            backgroundColor: l.backgroundColor || undefined,
            borderRadius: l.borderRadius,
            padding: `${l.paddingY * SCALE_Y}px ${l.paddingX * SCALE_X}px`,
            textAlign: l.textAlign,
            overflow: 'hidden',
            lineHeight: 1.2,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
          onClick={onSelect}
        >
          {content}
        </div>
      )
    }

    case 'image': {
      const l = layer as ImageLayer
      const isProductImage = l.src === '{{product_image}}'
      const displaySrc = isProductImage
        ? (previewProduct?.imageUrl || null)
        : l.src

      return (
        <div
          style={{
            ...style,
            borderRadius: l.borderRadius,
            overflow: 'hidden',
            backgroundColor: !displaySrc ? '#e5e7eb' : undefined,
          }}
          onClick={onSelect}
        >
          {displaySrc ? (
            <img
              src={displaySrc}
              alt=""
              style={{
                width: '100%',
                height: '100%',
                objectFit: l.objectFit === 'ai_extend' ? 'contain' : l.objectFit,
                display: 'block',
              }}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-xs text-gray-400">
              {isProductImage ? 'Product Image' : 'No image'}
            </div>
          )}
        </div>
      )
    }

    case 'badge': {
      const l = layer as BadgeLayer
      const content = previewProduct
        ? resolveVariables(l.content, previewProduct)
        : l.content
      return (
        <div
          style={{
            ...style,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: l.backgroundColor,
            color: l.color,
            fontSize: l.fontSize * SCALE_X,
            fontWeight: l.fontWeight,
            borderRadius: l.shape === 'circle' ? '50%' : l.borderRadius,
            overflow: 'hidden',
            textAlign: 'center',
          }}
          onClick={onSelect}
        >
          {content}
        </div>
      )
    }

    default:
      return null
  }
}

export function CanvasPreview() {
  const { canvasData, selectedLayerId, selectLayer, previewProduct } = useBuilderStore()

  const { width: cW, height: cH } = canvasData

  const scaleW = MAX_W / cW
  const scaleH = MAX_H / cH
  const scale = Math.min(scaleW, scaleH, 1)

  const displayW = Math.round(cW * scale)
  const displayH = Math.round(cH * scale)

  // Use preview product image URL for background if applicable
  const bgImage = canvasData.backgroundImageUrl

  return (
    <div className="flex flex-col items-center gap-3">
      <span className="text-xs text-muted-foreground">
        {cW} × {cH}px
      </span>
      <div
        style={{
          width: displayW,
          height: displayH,
          backgroundColor: canvasData.backgroundColor,
          backgroundImage: bgImage ? `url(${bgImage})` : undefined,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          position: 'relative',
          overflow: 'hidden',
          flexShrink: 0,
          boxShadow: '0 4px 32px rgba(0,0,0,0.12)',
          borderRadius: 6,
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
              canvasW={displayW}
              canvasH={displayH}
              previewProduct={previewProduct}
              onSelect={() => selectLayer(layer.id)}
            />
          ))}
      </div>
    </div>
  )
}