'use client'

import { useBuilderStore } from '@/stores/builder-store'
import { TextLayer, ImageLayer, RectangleLayer, BadgeLayer, DYNAMIC_VARIABLES } from '@/types/template'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Button } from '@/components/ui/button'

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  )
}

function NumInput({ value, onChange, min, max, step = 1 }: {
  value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number
}) {
  return (
    <Input
      type="number"
      value={value}
      min={min}
      max={max}
      step={step}
      className="h-7 text-xs"
      onChange={e => onChange(parseFloat(e.target.value) || 0)}
    />
  )
}

export function LayerProperties() {
  const { canvasData, selectedLayerId, updateLayer, setBackgroundColor } = useBuilderStore()
  const layer = canvasData.layers.find(l => l.id === selectedLayerId)

  if (!selectedLayerId || !layer) {
    return (
      <div className="p-4 space-y-4">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Canvas</p>
        <FieldRow label="Background color">
          <div className="flex gap-2">
            <input
              type="color"
              value={canvasData.backgroundColor}
              onChange={e => setBackgroundColor(e.target.value)}
              className="h-7 w-10 rounded border cursor-pointer"
            />
            <Input
              value={canvasData.backgroundColor}
              onChange={e => setBackgroundColor(e.target.value)}
              className="h-7 text-xs font-mono flex-1"
            />
          </div>
        </FieldRow>
        <p className="text-xs text-muted-foreground">Select a layer to edit its properties</p>
      </div>
    )
  }

  function upd(updates: any) {
    updateLayer(layer!.id, updates)
  }

  return (
    <div className="p-4 space-y-4">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        {layer.type.charAt(0).toUpperCase() + layer.type.slice(1)} Layer
      </p>

      {/* Position & Size */}
      <div className="grid grid-cols-2 gap-2">
        <FieldRow label="X %"><NumInput value={layer.x} onChange={v => upd({ x: v })} min={0} max={100} step={0.5} /></FieldRow>
        <FieldRow label="Y %"><NumInput value={layer.y} onChange={v => upd({ y: v })} min={0} max={100} step={0.5} /></FieldRow>
        <FieldRow label="W %"><NumInput value={layer.width} onChange={v => upd({ width: v })} min={1} max={100} step={0.5} /></FieldRow>
        <FieldRow label="H %"><NumInput value={layer.height} onChange={v => upd({ height: v })} min={1} max={100} step={0.5} /></FieldRow>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <FieldRow label="Rotation">
          <NumInput value={layer.rotation} onChange={v => upd({ rotation: v })} min={-360} max={360} />
        </FieldRow>
        <FieldRow label="Opacity">
          <NumInput value={Math.round(layer.opacity * 100)} onChange={v => upd({ opacity: v / 100 })} min={0} max={100} />
        </FieldRow>
      </div>

      <Separator />

      {/* Type-specific properties */}
      {layer.type === 'text' && (() => {
        const l = layer as TextLayer
        return (
          <div className="space-y-3">
            <FieldRow label="Content">
              <textarea
                value={l.content}
                onChange={e => upd({ content: e.target.value })}
                className="w-full text-xs border rounded p-2 min-h-[60px] resize-none bg-background"
              />
            </FieldRow>
            <FieldRow label="Insert variable">
              <Select onValueChange={v => upd({ content: l.content + v })}>
                <SelectTrigger className="h-7 text-xs"><SelectValue placeholder="Add variable…" /></SelectTrigger>
                <SelectContent>
                  {DYNAMIC_VARIABLES.filter(v => v.key !== '{{product_image}}').map(v => (
                    <SelectItem key={v.key} value={v.key} className="text-xs">{v.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FieldRow>
            <div className="grid grid-cols-2 gap-2">
              <FieldRow label="Font size"><NumInput value={l.fontSize} onChange={v => upd({ fontSize: v })} min={8} max={200} /></FieldRow>
              <FieldRow label="Weight">
                <Select value={l.fontWeight} onValueChange={v => upd({ fontWeight: v })}>
                  <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="normal">Normal</SelectItem>
                    <SelectItem value="bold">Bold</SelectItem>
                  </SelectContent>
                </Select>
              </FieldRow>
            </div>
            <FieldRow label="Color">
              <div className="flex gap-2">
                <input type="color" value={l.color} onChange={e => upd({ color: e.target.value })} className="h-7 w-10 rounded border cursor-pointer" />
                <Input value={l.color} onChange={e => upd({ color: e.target.value })} className="h-7 text-xs font-mono flex-1" />
              </div>
            </FieldRow>
            <FieldRow label="Align">
              <Select value={l.textAlign} onValueChange={v => upd({ textAlign: v })}>
                <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="left">Left</SelectItem>
                  <SelectItem value="center">Center</SelectItem>
                  <SelectItem value="right">Right</SelectItem>
                </SelectContent>
              </Select>
            </FieldRow>
          </div>
        )
      })()}

      {layer.type === 'rectangle' && (() => {
        const l = layer as RectangleLayer
        return (
          <div className="space-y-3">
            <FieldRow label="Fill color">
              <div className="flex gap-2">
                <input type="color" value={l.backgroundColor} onChange={e => upd({ backgroundColor: e.target.value })} className="h-7 w-10 rounded border cursor-pointer" />
                <Input value={l.backgroundColor} onChange={e => upd({ backgroundColor: e.target.value })} className="h-7 text-xs font-mono flex-1" />
              </div>
            </FieldRow>
            <FieldRow label="Border radius"><NumInput value={l.borderRadius} onChange={v => upd({ borderRadius: v })} min={0} max={500} /></FieldRow>
            <FieldRow label="Border width"><NumInput value={l.borderWidth} onChange={v => upd({ borderWidth: v })} min={0} max={20} /></FieldRow>
            {l.borderWidth > 0 && (
              <FieldRow label="Border color">
                <div className="flex gap-2">
                  <input type="color" value={l.borderColor} onChange={e => upd({ borderColor: e.target.value })} className="h-7 w-10 rounded border cursor-pointer" />
                  <Input value={l.borderColor} onChange={e => upd({ borderColor: e.target.value })} className="h-7 text-xs font-mono flex-1" />
                </div>
              </FieldRow>
            )}
          </div>
        )
      })()}

      {layer.type === 'badge' && (() => {
        const l = layer as BadgeLayer
        return (
          <div className="space-y-3">
            <FieldRow label="Content">
              <textarea
                value={l.content}
                onChange={e => upd({ content: e.target.value })}
                className="w-full text-xs border rounded p-2 min-h-[48px] resize-none bg-background"
              />
            </FieldRow>
            <FieldRow label="Insert variable">
              <Select onValueChange={v => upd({ content: l.content + v })}>
                <SelectTrigger className="h-7 text-xs"><SelectValue placeholder="Add variable…" /></SelectTrigger>
                <SelectContent>
                  {DYNAMIC_VARIABLES.filter(d => d.key !== '{{product_image}}').map(v => (
                    <SelectItem key={v.key} value={v.key} className="text-xs">{v.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FieldRow>
            <div className="grid grid-cols-2 gap-2">
              <FieldRow label="Bg color">
                <input type="color" value={l.backgroundColor} onChange={e => upd({ backgroundColor: e.target.value })} className="h-7 w-full rounded border cursor-pointer" />
              </FieldRow>
              <FieldRow label="Text color">
                <input type="color" value={l.color} onChange={e => upd({ color: e.target.value })} className="h-7 w-full rounded border cursor-pointer" />
              </FieldRow>
            </div>
            <FieldRow label="Font size"><NumInput value={l.fontSize} onChange={v => upd({ fontSize: v })} min={8} max={120} /></FieldRow>
            <FieldRow label="Shape">
              <Select value={l.shape} onValueChange={v => upd({ shape: v })}>
                <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="rectangle">Rectangle</SelectItem>
                  <SelectItem value="circle">Circle</SelectItem>
                </SelectContent>
              </Select>
            </FieldRow>
          </div>
        )
      })()}

      {layer.type === 'image' && (() => {
        const l = layer as ImageLayer
        return (
          <div className="space-y-3">
            <FieldRow label="Source">
              <Select value={l.src === '{{product_image}}' ? '{{product_image}}' : 'custom'} onValueChange={v => upd({ src: v })}>
                <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="{{product_image}}">Product Image</SelectItem>
                  <SelectItem value="custom">Custom URL</SelectItem>
                </SelectContent>
              </Select>
            </FieldRow>
            {l.src !== '{{product_image}}' && (
              <FieldRow label="Image URL">
                <Input value={l.src} onChange={e => upd({ src: e.target.value })} className="h-7 text-xs" placeholder="https://…" />
              </FieldRow>
            )}
            <FieldRow label="Fit">
              <Select value={l.objectFit} onValueChange={v => upd({ objectFit: v })}>
                <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="cover">Cover</SelectItem>
                  <SelectItem value="contain">Contain</SelectItem>
                  <SelectItem value="fill">Fill</SelectItem>
                </SelectContent>
              </Select>
            </FieldRow>
            <FieldRow label="Border radius"><NumInput value={l.borderRadius} onChange={v => upd({ borderRadius: v })} min={0} max={500} /></FieldRow>
          </div>
        )
      })()}
    </div>
  )
}