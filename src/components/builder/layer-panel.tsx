'use client'

import { useBuilderStore } from '@/stores/builder-store'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Trash2, Copy, ChevronUp, ChevronDown, Type, Image, Square, Tag, Layers, BadgePlus, Sticker } from 'lucide-react'
import { Layer } from '@/types/template'

function LayerIcon({ type }: { type: Layer['type'] }) {
  const icons = { text: Type, image: Image, rectangle: Square, badge: Tag, logo: BadgePlus, overlay: Layers, sticker: Sticker }
  const Icon = icons[type] || Square
  return <Icon className="h-3.5 w-3.5 flex-shrink-0" />
}

function layerLabel(layer: Layer): string {
  switch (layer.type) {
    case 'text': return layer.content.replace(/{{[^}]+}}/g, m => m.slice(2, -2)).slice(0, 20) || 'Text'
    case 'image': return layer.src === '{{product_image}}' ? 'Product Image' : 'Image'
    case 'badge': return 'Badge'
    case 'rectangle': return 'Rectangle'
    case 'overlay': return 'Template design'
    case 'logo': return 'Logo'
    case 'sticker': return 'Sticker'
    default: return 'Layer'
  }
}

export function LayerPanel() {
  const { canvasData, selectedLayerId, selectLayer, deleteLayer, duplicateLayer, moveLayerUp, moveLayerDown } =
    useBuilderStore()

  const layers = [...canvasData.layers].reverse() // show top layers first

  return (
    <div className="flex-1 overflow-y-auto p-3">
      <p className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wide">
        Layers ({layers.length})
      </p>
      {layers.length === 0 && (
        <p className="text-xs text-muted-foreground text-center py-6">No layers yet</p>
      )}
      <div className="space-y-1">
        {layers.map(layer => (
          <div
            key={layer.id}
            className={cn(
              'flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer text-xs group transition-colors',
              selectedLayerId === layer.id
                ? 'bg-primary text-primary-foreground'
                : 'hover:bg-muted'
            )}
            onClick={() => selectLayer(layer.id)}
          >
            <LayerIcon type={layer.type} />
            <span className="flex-1 truncate">{layerLabel(layer)}</span>
            <div className={cn(
              'items-center gap-0.5 hidden group-hover:flex',
              selectedLayerId === layer.id && 'flex'
            )}>
              <button onClick={e => { e.stopPropagation(); moveLayerUp(layer.id) }} className="hover:opacity-70 p-0.5">
                <ChevronUp className="h-3 w-3" />
              </button>
              <button onClick={e => { e.stopPropagation(); moveLayerDown(layer.id) }} className="hover:opacity-70 p-0.5">
                <ChevronDown className="h-3 w-3" />
              </button>
              <button onClick={e => { e.stopPropagation(); duplicateLayer(layer.id) }} className="hover:opacity-70 p-0.5">
                <Copy className="h-3 w-3" />
              </button>
              <button onClick={e => { e.stopPropagation(); deleteLayer(layer.id) }} className="hover:opacity-70 p-0.5">
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}