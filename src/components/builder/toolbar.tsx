'use client'

import { useBuilderStore } from '@/stores/builder-store'
import { Button } from '@/components/ui/button'
import { Type, Image, Square, Tag, Star } from 'lucide-react'
import { TextLayer, ImageLayer, RectangleLayer, BadgeLayer } from '@/types/template'

export function ToolBar() {
  const { addLayer } = useBuilderStore()

  function addText() {
    addLayer({
      type: 'text',
      x: 10, y: 10, width: 80, height: 10,
      rotation: 0, opacity: 1,
      content: '{{title}}',
      fontSize: 48,
      fontFamily: 'Inter, sans-serif',
      fontWeight: 'bold',
      color: '#000000',
      backgroundColor: null,
      borderRadius: 0,
      paddingX: 8,
      paddingY: 4,
      textAlign: 'left',
    } as Omit<TextLayer, 'id' | 'zIndex'>)
  }

  function addImage() {
    addLayer({
      type: 'image',
      x: 10, y: 10, width: 80, height: 80,
      rotation: 0, opacity: 1,
      src: '{{product_image}}',
      objectFit: 'cover',
      borderRadius: 8,
    } as Omit<ImageLayer, 'id' | 'zIndex'>)
  }

  function addRectangle() {
    addLayer({
      type: 'rectangle',
      x: 10, y: 10, width: 40, height: 20,
      rotation: 0, opacity: 1,
      backgroundColor: '#000000',
      borderRadius: 8,
      borderWidth: 0,
      borderColor: '#000000',
    } as Omit<RectangleLayer, 'id' | 'zIndex'>)
  }

  function addBadge() {
    addLayer({
      type: 'badge',
      x: 60, y: 5, width: 30, height: 12,
      rotation: 0, opacity: 1,
      content: '{{discount_percentage}}% OFF',
      backgroundColor: '#ef4444',
      color: '#ffffff',
      fontSize: 32,
      fontWeight: 'bold',
      borderRadius: 8,
      shape: 'rectangle',
    } as Omit<BadgeLayer, 'id' | 'zIndex'>)
  }

  const tools = [
    { label: 'Text', icon: Type, action: addText },
    { label: 'Image', icon: Image, action: addImage },
    { label: 'Rectangle', icon: Square, action: addRectangle },
    { label: 'Badge', icon: Tag, action: addBadge },
  ]

  return (
    <div className="p-3 border-b">
      <p className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wide">Add layer</p>
      <div className="grid grid-cols-2 gap-1.5">
        {tools.map(({ label, icon: Icon, action }) => (
          <Button
            key={label}
            variant="outline"
            size="sm"
            className="h-9 flex flex-col gap-0.5 text-xs"
            onClick={action}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </Button>
        ))}
      </div>
    </div>
  )
}