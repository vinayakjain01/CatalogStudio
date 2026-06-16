'use client'

import { useBuilderStore } from '@/stores/builder-store'
import { AspectRatio, ASPECT_RATIOS, BackgroundMode, DEFAULT_BACKGROUND_SETTINGS } from '@/types/template'
import { TextLayer, ImageLayer, RectangleLayer, BadgeLayer, OverlayLayer, LogoLayer, DYNAMIC_VARIABLES } from '@/types/template'
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
  const { canvasData, selectedLayerId, updateLayer, setBackgroundColor, setAspectRatio, setCanvasSize, setBackgroundSettings } = useBuilderStore()
  const layer = canvasData.layers.find(l => l.id === selectedLayerId)
  const bgSettings = canvasData.backgroundSettings ?? DEFAULT_BACKGROUND_SETTINGS

  if (!selectedLayerId || !layer) {
    return (
      <div className="p-4 space-y-4">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Canvas</p>

        {/* Aspect ratio */}
        <FieldRow label="Aspect ratio">
          <Select
            value={canvasData.aspectRatio || '1:1'}
            onValueChange={v => setAspectRatio(v as AspectRatio)}
          >
            <SelectTrigger className="h-7 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ASPECT_RATIOS.map(r => (
                <SelectItem key={r.value} value={r.value} className="text-xs">
                  {r.label}
                </SelectItem>
              ))}
              <SelectItem value="custom" className="text-xs">Custom size…</SelectItem>
            </SelectContent>
          </Select>
        </FieldRow>

        {/* Canvas size: editable when custom, read-only otherwise */}
        {canvasData.aspectRatio === 'custom' ? (
          <div className="grid grid-cols-2 gap-2">
            <FieldRow label="Width (px)">
              <NumInput
                value={canvasData.width}
                onChange={v => setCanvasSize(v, canvasData.height)}
                min={200} max={4000} step={10}
              />
            </FieldRow>
            <FieldRow label="Height (px)">
              <NumInput
                value={canvasData.height}
                onChange={v => setCanvasSize(canvasData.width, v)}
                min={200} max={4000} step={10}
              />
            </FieldRow>
          </div>
        ) : (
          <FieldRow label="Canvas size">
            <p className="text-xs text-muted-foreground bg-muted px-2 py-1.5 rounded">
              {canvasData.width} × {canvasData.height} px
            </p>
          </FieldRow>
        )}

        <Separator />

        {/* ── Background Settings ─────────────────────────────────────────── */}
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Background</p>

        {/* Mode selector */}
        <FieldRow label="Background mode">
          <Select
            value={bgSettings.mode}
            onValueChange={v => setBackgroundSettings({ mode: v as BackgroundMode })}
          >
            <SelectTrigger className="h-7 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="solid" className="text-xs">Solid color</SelectItem>
              <SelectItem value="smart" className="text-xs">✨ Smart Fill</SelectItem>
              <SelectItem value="blur-extend" className="text-xs">Blur Extend</SelectItem>
              <SelectItem value="gradient" className="text-xs">Gradient</SelectItem>
              <SelectItem value="transparent" className="text-xs">Transparent</SelectItem>
            </SelectContent>
          </Select>
        </FieldRow>

        {/* Mode description */}
        {bgSettings.mode === 'smart' && (
          <p className="text-[11px] text-muted-foreground leading-snug bg-muted/60 rounded px-2 py-1.5">
            Analyzes product image colors and generates a matching blended background — no white gaps.
          </p>
        )}
        {bgSettings.mode === 'blur-extend' && (
          <p className="text-[11px] text-muted-foreground leading-snug bg-muted/60 rounded px-2 py-1.5">
            Creates a blurred, zoomed version of the image behind it — as seen on Instagram and Canva.
          </p>
        )}
        {bgSettings.mode === 'gradient' && (
          <p className="text-[11px] text-muted-foreground leading-snug bg-muted/60 rounded px-2 py-1.5">
            Linear gradient. Enable Auto Colors to derive shades from the product image automatically.
          </p>
        )}
        {bgSettings.mode === 'transparent' && (
          <p className="text-[11px] text-muted-foreground leading-snug bg-muted/60 rounded px-2 py-1.5">
            Transparent background. Useful for PNG exports placed on custom backgrounds.
          </p>
        )}

        {/* Solid color — always shown (it's the base/fallback for all modes) */}
        {(bgSettings.mode === 'solid' || bgSettings.mode === 'smart' || bgSettings.mode === 'blur-extend') && (
          <FieldRow label={bgSettings.mode === 'solid' ? 'Color' : 'Fallback color'}>
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
        )}

        {/* Blur strength — for smart and blur-extend */}
        {(bgSettings.mode === 'smart' || bgSettings.mode === 'blur-extend') && (
          <FieldRow label={`Blur strength (${bgSettings.blurStrength})`}>
            <input
              type="range"
              min={0} max={40} step={1}
              value={bgSettings.blurStrength}
              onChange={e => setBackgroundSettings({ blurStrength: Number(e.target.value) })}
              className="w-full accent-primary h-4"
            />
          </FieldRow>
        )}

        {/* Blend strength — for smart only */}
        {bgSettings.mode === 'smart' && (
          <FieldRow label={`Blend strength (${Math.round(bgSettings.blendStrength * 100)}%)`}>
            <input
              type="range"
              min={0} max={100} step={5}
              value={Math.round(bgSettings.blendStrength * 100)}
              onChange={e => setBackgroundSettings({ blendStrength: Number(e.target.value) / 100 })}
              className="w-full accent-primary h-4"
            />
          </FieldRow>
        )}

        {/* Gradient controls */}
        {bgSettings.mode === 'gradient' && (
          <div className="space-y-3">
            <FieldRow label="Auto colors from image">
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={bgSettings.autoColors}
                  onChange={e => setBackgroundSettings({ autoColors: e.target.checked })}
                  className="h-4 w-4 accent-primary cursor-pointer"
                  id="auto-colors"
                />
                <label htmlFor="auto-colors" className="text-xs cursor-pointer">
                  Derive from product image
                </label>
              </div>
            </FieldRow>

            <FieldRow label={`Angle (${bgSettings.gradientAngle}°)`}>
              <input
                type="range"
                min={0} max={360} step={5}
                value={bgSettings.gradientAngle}
                onChange={e => setBackgroundSettings({ gradientAngle: Number(e.target.value) })}
                className="w-full accent-primary h-4"
              />
            </FieldRow>

            {!bgSettings.autoColors && (
              <>
                <FieldRow label="Start color">
                  <div className="flex gap-2">
                    <input
                      type="color"
                      value={bgSettings.gradientStops[0]?.color ?? '#f0f0f0'}
                      onChange={e => {
                        const stops = [...bgSettings.gradientStops]
                        stops[0] = { ...stops[0], color: e.target.value }
                        setBackgroundSettings({ gradientStops: stops })
                      }}
                      className="h-7 w-10 rounded border cursor-pointer"
                    />
                    <Input
                      value={bgSettings.gradientStops[0]?.color ?? '#f0f0f0'}
                      onChange={e => {
                        const stops = [...bgSettings.gradientStops]
                        stops[0] = { ...stops[0], color: e.target.value }
                        setBackgroundSettings({ gradientStops: stops })
                      }}
                      className="h-7 text-xs font-mono flex-1"
                    />
                  </div>
                </FieldRow>
                <FieldRow label="End color">
                  <div className="flex gap-2">
                    <input
                      type="color"
                      value={bgSettings.gradientStops[1]?.color ?? '#d0d0d0'}
                      onChange={e => {
                        const stops = [...bgSettings.gradientStops]
                        stops[1] = { ...stops[1], color: e.target.value }
                        setBackgroundSettings({ gradientStops: stops })
                      }}
                      className="h-7 w-10 rounded border cursor-pointer"
                    />
                    <Input
                      value={bgSettings.gradientStops[1]?.color ?? '#d0d0d0'}
                      onChange={e => {
                        const stops = [...bgSettings.gradientStops]
                        stops[1] = { ...stops[1], color: e.target.value }
                        setBackgroundSettings({ gradientStops: stops })
                      }}
                      className="h-7 text-xs font-mono flex-1"
                    />
                  </div>
                </FieldRow>
              </>
            )}
          </div>
        )}

        <p className="text-xs text-muted-foreground pt-1">Select a layer to edit its properties</p>
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
            {/* Quick fit buttons */}
            <FieldRow label="Quick fit">
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="flex-1 h-7 text-xs"
                  onClick={() => upd({ x: 0, y: 0, width: 100, height: 100, objectFit: 'cover' })}
                >
                  Fill canvas
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="flex-1 h-7 text-xs"
                  onClick={() => upd({ x: 0, y: 0, width: 100, height: 100, objectFit: 'contain' })}
                >
                  Fit canvas
                </Button>
              </div>
            </FieldRow>

            {/* Source */}
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
                  <SelectItem value="cover">Cover (fills, may crop)</SelectItem>
                  <SelectItem value="contain">Contain (full image, may letterbox)</SelectItem>
                  <SelectItem value="fill">Stretch (fills, distorts)</SelectItem>
                </SelectContent>
              </Select>
            </FieldRow>

            <FieldRow label="Border radius">
              <NumInput value={l.borderRadius} onChange={v => upd({ borderRadius: v })} min={0} max={500} />
            </FieldRow>
          </div>
        )
      })()}

      {layer.type === 'overlay' && (() => {
        const l = layer as OverlayLayer
        return (
          <div className="space-y-3">
            <FieldRow label="Design preview">
              <img src={l.src} alt="" className="w-full rounded border bg-muted/30 object-contain max-h-32" />
            </FieldRow>
            <FieldRow label="Placement">
              <Select
                value={l.placement}
                onValueChange={(v) => {
                  // above = render in front of product (high zIndex)
                  // below = render behind product (low zIndex)
                  const layers = [...canvasData.layers]
                  const maxZ = Math.max(0, ...layers.map(x => x.zIndex))
                  upd({ placement: v, zIndex: v === 'above' ? maxZ + 1 : -1 })
                }}
              >
                <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="above">Above product (frame)</SelectItem>
                  <SelectItem value="below">Below product (background)</SelectItem>
                </SelectContent>
              </Select>
            </FieldRow>
            <FieldRow label="Fit">
              <Select value={l.objectFit} onValueChange={v => upd({ objectFit: v })}>
                <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="contain">Contain</SelectItem>
                  <SelectItem value="cover">Cover</SelectItem>
                  <SelectItem value="fill">Fill</SelectItem>
                </SelectContent>
              </Select>
            </FieldRow>
            <p className="text-[11px] text-muted-foreground leading-snug">
              Tip: an &quot;above&quot; design needs transparent areas (PNG) where the product should show through.
            </p>
          </div>
        )
      })()}

      {(layer.type === 'logo' || layer.type === 'sticker') && (() => {
        const l = layer as LogoLayer
        return (
          <div className="space-y-3">
            <FieldRow label={layer.type === 'sticker' ? 'Sticker preview' : 'Logo preview'}>
              <img src={l.src} alt="" className="w-full rounded border bg-muted/30 object-contain max-h-24" />
            </FieldRow>
            <FieldRow label="Fit">
              <Select value={l.objectFit} onValueChange={v => upd({ objectFit: v })}>
                <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="contain">Contain</SelectItem>
                  <SelectItem value="cover">Cover</SelectItem>
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