'use client'

import { useBuilderStore } from '@/stores/builder-store'
import { DEFAULT_PRODUCT_LAYER_SETTINGS } from '@/types/template'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import {
  Sparkles,
  Move,
  SunDim,
  RotateCcw,
  Maximize2,
  Info,
} from 'lucide-react'

export function AiProductModePanel() {
  const {
    canvasData,
    setTemplateMode,
    setProductLayerSettings,
    previewProduct,
  } = useBuilderStore()

  const mode = canvasData.templateMode || 'standard'
  const settings = canvasData.productLayerSettings || DEFAULT_PRODUCT_LAYER_SETTINGS
  const isAiMode = mode === 'ai_product'

  return (
    <div className="space-y-4 p-4">
      {/* Mode Toggle */}
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Template Mode</p>
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => setTemplateMode('standard')}
            className={`p-3 rounded-lg border text-left transition-all ${
              !isAiMode
                ? 'border-primary bg-primary/5 text-primary'
                : 'border-border hover:border-muted-foreground/40'
            }`}
          >
            <p className="text-xs font-semibold">Standard</p>
            <p className="text-xs text-muted-foreground mt-0.5">Product image as-is</p>
          </button>
          <button
            onClick={() => setTemplateMode('ai_product')}
            className={`p-3 rounded-lg border text-left transition-all ${
              isAiMode
                ? 'border-primary bg-primary/5 text-primary'
                : 'border-border hover:border-muted-foreground/40'
            }`}
          >
            <div className="flex items-center gap-1.5">
              <p className="text-xs font-semibold">AI Product</p>
              <Sparkles className="h-3 w-3" />
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">Remove background</p>
          </button>
        </div>
      </div>

      {isAiMode && (
        <>
          {/* Info banner */}
          <div className="flex gap-2 p-2.5 rounded-lg bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-300">
            <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <p className="text-xs leading-snug">
              Background is removed during generation. The transparent product floats above your template design. Make your template background first, then adjust position here.
            </p>
          </div>

          <Separator />

          {/* Position & Size */}
          <div className="space-y-3">
            <div className="flex items-center gap-1.5">
              <Move className="h-3.5 w-3.5 text-muted-foreground" />
              <p className="text-xs font-medium">Position & Size</p>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <SliderField
                label="X Position"
                value={settings.x}
                min={0} max={80}
                onChange={v => setProductLayerSettings({ x: v })}
                unit="%"
              />
              <SliderField
                label="Y Position"
                value={settings.y}
                min={0} max={80}
                onChange={v => setProductLayerSettings({ y: v })}
                unit="%"
              />
              <SliderField
                label="Width"
                value={settings.width}
                min={10} max={100}
                onChange={v => setProductLayerSettings({ width: v })}
                unit="%"
              />
              <SliderField
                label="Height"
                value={settings.height}
                min={10} max={100}
                onChange={v => setProductLayerSettings({ height: v })}
                unit="%"
              />
            </div>

            {/* Quick position presets */}
            <div className="flex gap-1 flex-wrap">
              {[
                { label: 'Center', x: 10, y: 5, w: 80, h: 80 },
                { label: 'Left', x: 2, y: 10, w: 55, h: 75 },
                { label: 'Right', x: 43, y: 10, w: 55, h: 75 },
                { label: 'Bottom', x: 10, y: 35, w: 80, h: 60 },
              ].map(preset => (
                <button
                  key={preset.label}
                  onClick={() => setProductLayerSettings({
                    x: preset.x, y: preset.y,
                    width: preset.w, height: preset.h,
                  })}
                  className="text-xs px-2 py-1 rounded border border-border hover:bg-muted transition-colors"
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          <Separator />

          {/* Transform */}
          <div className="space-y-3">
            <div className="flex items-center gap-1.5">
              <RotateCcw className="h-3.5 w-3.5 text-muted-foreground" />
              <p className="text-xs font-medium">Transform</p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <SliderField
                label="Rotation"
                value={settings.rotation}
                min={-45} max={45}
                onChange={v => setProductLayerSettings({ rotation: v })}
                unit="°"
              />
              <SliderField
                label="Opacity"
                value={Math.round(settings.opacity * 100)}
                min={10} max={100}
                onChange={v => setProductLayerSettings({ opacity: v / 100 })}
                unit="%"
              />
              <SliderField
                label="Padding"
                value={settings.padding}
                min={0} max={20}
                onChange={v => setProductLayerSettings({ padding: v })}
                unit="%"
              />
              <SliderField
                label="Layer Z"
                value={settings.zIndex}
                min={1} max={20}
                onChange={v => setProductLayerSettings({ zIndex: v })}
              />
            </div>
          </div>

          <Separator />

          {/* Object Fit */}
          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <Maximize2 className="h-3.5 w-3.5 text-muted-foreground" />
              <p className="text-xs font-medium">Fit Mode</p>
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {(['contain', 'cover', 'fill'] as const).map(fit => (
                <button
                  key={fit}
                  onClick={() => setProductLayerSettings({ objectFit: fit })}
                  className={`py-1.5 text-xs rounded border transition-all ${
                    settings.objectFit === fit
                      ? 'border-primary bg-primary/5 text-primary font-medium'
                      : 'border-border hover:border-muted-foreground/40'
                  }`}
                >
                  {fit.charAt(0).toUpperCase() + fit.slice(1)}
                </button>
              ))}
            </div>
          </div>

          <Separator />

          {/* Shadow & Glow */}
          <div className="space-y-3">
            <div className="flex items-center gap-1.5">
              <SunDim className="h-3.5 w-3.5 text-muted-foreground" />
              <p className="text-xs font-medium">Effects</p>
            </div>

            {/* Drop Shadow */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">Drop Shadow</p>
                <ToggleButton
                  active={settings.shadow}
                  onToggle={() => setProductLayerSettings({ shadow: !settings.shadow })}
                />
              </div>
              {settings.shadow && (
                <div className="grid grid-cols-2 gap-2 pl-2 border-l-2 border-primary/30">
                  <SliderField
                    label="Blur"
                    value={settings.shadowBlur}
                    min={0} max={60}
                    onChange={v => setProductLayerSettings({ shadowBlur: v })}
                    unit="px"
                  />
                  <SliderField
                    label="Offset Y"
                    value={settings.shadowOffsetY}
                    min={-30} max={60}
                    onChange={v => setProductLayerSettings({ shadowOffsetY: v })}
                    unit="px"
                  />
                  <div className="col-span-2 space-y-1">
                    <p className="text-xs text-muted-foreground">Shadow Color</p>
                    <div className="flex gap-2">
                      {[
                        'rgba(0,0,0,0.2)', 'rgba(0,0,0,0.4)',
                        'rgba(59,130,246,0.3)', 'rgba(239,68,68,0.3)',
                      ].map(color => (
                        <button
                          key={color}
                          onClick={() => setProductLayerSettings({ shadowColor: color })}
                          className={`w-6 h-6 rounded-full border-2 transition-all ${
                            settings.shadowColor === color ? 'border-primary scale-110' : 'border-transparent'
                          }`}
                          style={{ background: color.replace('rgba', 'rgb').replace(',0.', ',').slice(0, -1) + ')' }}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Glow */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">Glow Effect</p>
                <ToggleButton
                  active={settings.glow}
                  onToggle={() => setProductLayerSettings({ glow: !settings.glow })}
                />
              </div>
              {settings.glow && (
                <div className="grid grid-cols-2 gap-2 pl-2 border-l-2 border-primary/30">
                  <SliderField
                    label="Blur"
                    value={settings.glowBlur}
                    min={0} max={50}
                    onChange={v => setProductLayerSettings({ glowBlur: v })}
                    unit="px"
                  />
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">Glow Color</p>
                    <div className="flex gap-1.5">
                      {[
                        'rgba(255,255,255,0.6)', 'rgba(255,220,100,0.5)',
                        'rgba(100,200,255,0.5)', 'rgba(200,100,255,0.5)',
                      ].map(color => (
                        <button
                          key={color}
                          onClick={() => setProductLayerSettings({ glowColor: color })}
                          className={`w-5 h-5 rounded-full border-2 transition-all ${
                            settings.glowColor === color ? 'border-primary scale-110' : 'border-transparent'
                          }`}
                          style={{ background: color }}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          <Separator />

          {/* Reset */}
          <Button
            variant="outline"
            size="sm"
            className="w-full text-xs"
            onClick={() => setProductLayerSettings(DEFAULT_PRODUCT_LAYER_SETTINGS)}
          >
            Reset to defaults
          </Button>
        </>
      )}
    </div>
  )
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function SliderField({
  label, value, min, max, onChange, unit = '',
}: {
  label: string
  value: number
  min: number
  max: number
  onChange: (v: number) => void
  unit?: string
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">{label}</p>
        <span className="text-xs font-mono text-foreground">{value}{unit}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="w-full h-1.5 accent-primary cursor-pointer"
      />
    </div>
  )
}

function ToggleButton({ active, onToggle }: { active: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
        active ? 'bg-primary' : 'bg-muted-foreground/30'
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform shadow-sm ${
          active ? 'translate-x-4.5' : 'translate-x-0.5'
        }`}
      />
    </button>
  )
}