'use client'

import { useBuilderStore } from '@/stores/builder-store'
import { DEFAULT_PRODUCT_POSITIONING_SETTINGS, SHOT_TYPES, type ShotType } from '@/types/template'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import {
  AlignVerticalJustifyStart,
  ZoomIn,
  Move,
  Info,
  Eye,
  EyeOff,
  RotateCcw,
  Tags,
} from 'lucide-react'

const SHOT_TYPE_LABELS: Record<ShotType, string> = {
  full_body: 'Full Body',
  half_body: 'Half Body',
  close_up: 'Close-up',
  detail: 'Detail',
  flat_lay: 'Flat Lay',
  accessory: 'Accessory',
}

export function ProductPositioningPanel() {
  const { canvasData, setProductPositioningSettings } = useBuilderStore()

  const settings = canvasData.productPositioningSettings ?? DEFAULT_PRODUCT_POSITIONING_SETTINGS
  const isAiMode = canvasData.templateMode === 'ai_product'
  const isZoomMode = canvasData.templateMode === 'product_zoom'
  const maxHeadSpace = Math.round((canvasData.height || 1080) * 0.7)

  function toggleShotType(type: ShotType) {
    const current = settings.applyToShotTypes
    const next = current.includes(type)
      ? current.filter(t => t !== type)
      : [...current, type]
    setProductPositioningSettings({ applyToShotTypes: next })
  }

  return (
    <div className="space-y-4 p-4">
      {/* Enable/disable */}
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Product Positioning</p>
        <p className="text-xs text-muted-foreground">
          Align every product at the same head position — like Zara, H&amp;M, Myntra.
        </p>
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => setProductPositioningSettings({ enabled: false })}
            className={`p-3 rounded-lg border text-left transition-all ${
              !settings.enabled
                ? 'border-primary bg-primary/5 text-primary'
                : 'border-border hover:border-muted-foreground/40'
            }`}
          >
            <p className="text-xs font-semibold">Off</p>
            <p className="text-xs text-muted-foreground mt-0.5">Use manual layout</p>
          </button>
          <button
            onClick={() => setProductPositioningSettings({ enabled: true })}
            className={`p-3 rounded-lg border text-left transition-all ${
              settings.enabled
                ? 'border-primary bg-primary/5 text-primary'
                : 'border-border hover:border-muted-foreground/40'
            }`}
          >
            <p className="text-xs font-semibold">On</p>
            <p className="text-xs text-muted-foreground mt-0.5">Auto-align products</p>
          </button>
        </div>
      </div>

      {settings.enabled && (
        <>
          {/* Info banner */}
          <div className={`flex gap-2 p-2.5 rounded-lg ${
            isAiMode || isZoomMode
              ? 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300'
              : 'bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-300'
          }`}>
            <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <p className="text-xs leading-snug">
              {isZoomMode
                ? "Product Zoom mode positions the photo itself — no cutout, no background removal. Applied automatically to full-body and half-body shots by default; check off every shot type below (flat lay, close-up, detail, accessory) you also want normalized, since Product Zoom's whole point is consistent framing across all product types."
                : 'Applied automatically to full-body and half-body shots. Flat lays, close-ups, detail shots, and accessories are detected and left exactly as-is. You can correct a misdetection per-product from the product page.'}
            </p>
          </div>

          <Separator />

          {/* Head Space */}
          <div className="space-y-3">
            <div className="flex items-center gap-1.5">
              <AlignVerticalJustifyStart className="h-3.5 w-3.5 text-muted-foreground" />
              <p className="text-xs font-medium">Head Space</p>
            </div>
            <SliderField
              label="Distance from top"
              value={settings.headSpacePx}
              min={0} max={maxHeadSpace}
              onChange={v => setProductPositioningSettings({ headSpacePx: v })}
              unit="px"
            />
          </div>

          <Separator />

          {/* Scale Mode */}
          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <ZoomIn className="h-3.5 w-3.5 text-muted-foreground" />
              <p className="text-xs font-medium">Scale Mode</p>
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              <button
                onClick={() => setProductPositioningSettings({ scaleMode: 'fit' })}
                className={`py-1.5 text-xs rounded border transition-all ${
                  settings.scaleMode === 'fit'
                    ? 'border-primary bg-primary/5 text-primary font-medium'
                    : 'border-border hover:border-muted-foreground/40'
                }`}
              >
                Fit
              </button>
              <button
                onClick={() => setProductPositioningSettings({ scaleMode: 'smart_fit' })}
                className={`py-1.5 text-xs rounded border transition-all ${
                  settings.scaleMode === 'smart_fit'
                    ? 'border-primary bg-primary/5 text-primary font-medium'
                    : 'border-border hover:border-muted-foreground/40'
                }`}
              >
                Smart Fit
              </button>
              <button
                onClick={() => setProductPositioningSettings({ scaleMode: 'fill' })}
                className={`py-1.5 text-xs rounded border transition-all ${
                  settings.scaleMode === 'fill'
                    ? 'border-primary bg-primary/5 text-primary font-medium'
                    : 'border-border hover:border-muted-foreground/40'
                }`}
              >
                Fill
              </button>
            </div>
            <p className="text-xs text-muted-foreground">
              {settings.scaleMode === 'fill'
                ? 'Always zooms so the head AND the bottom guide are both hit exactly — cropping background from the sides if needed. Use this if Smart Fit is leaving a gap above or below the product.'
                : settings.scaleMode === 'smart_fit'
                ? 'Moves the product to hit the head-space target first, scaling only as much as needed. Never crops — so it can leave a gap at the bottom guide if the product is wide relative to the canvas.'
                : 'Plain contain scaling — moves the product without zooming.'}
            </p>
            <SliderField
              label="Max upscale"
              value={settings.maxUpscale}
              min={1} max={3} step={0.1}
              onChange={v => setProductPositioningSettings({ maxUpscale: v })}
              unit="×"
            />
            <p className="text-xs text-muted-foreground">
              Caps how far Smart Fit may zoom in beyond a plain fit, so tightly-cropped photos never blow up into blur.
            </p>
          </div>

          <Separator />

          {/* Margins */}
          <div className="space-y-3">
            <div className="flex items-center gap-1.5">
              <Move className="h-3.5 w-3.5 text-muted-foreground" />
              <p className="text-xs font-medium">Safe Area Margins</p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <SliderField
                label="Left"
                value={settings.leftMarginPx}
                min={0} max={200}
                onChange={v => setProductPositioningSettings({ leftMarginPx: v })}
                unit="px"
              />
              <SliderField
                label="Right"
                value={settings.rightMarginPx}
                min={0} max={200}
                onChange={v => setProductPositioningSettings({ rightMarginPx: v })}
                unit="px"
              />
              <SliderField
                label="Bottom"
                value={settings.bottomMarginPx}
                min={0} max={600}
                onChange={v => setProductPositioningSettings({ bottomMarginPx: v })}
                unit="px"
              />
            </div>
            <div className="flex items-center justify-between pt-1">
              <p className="text-xs text-muted-foreground">Auto-center horizontally</p>
              <ToggleButton
                active={settings.autoCenterHorizontally}
                onToggle={() => setProductPositioningSettings({ autoCenterHorizontally: !settings.autoCenterHorizontally })}
              />
            </div>
          </div>

          <Separator />

          {/* Shot types */}
          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <Tags className="h-3.5 w-3.5 text-muted-foreground" />
              <p className="text-xs font-medium">Shot Types to Apply</p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {SHOT_TYPES.map(type => (
                <button
                  key={type}
                  onClick={() => toggleShotType(type)}
                  className={`text-xs px-2 py-1 rounded-full border transition-all ${
                    settings.applyToShotTypes.includes(type)
                      ? 'border-primary bg-primary/5 text-primary font-medium'
                      : 'border-border text-muted-foreground hover:border-muted-foreground/40'
                  }`}
                >
                  {SHOT_TYPE_LABELS[type]}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Detected automatically per product. Override a single product&apos;s detected shot type
              from its product detail page.
            </p>
          </div>

          <Separator />

          {/* Guide toggle */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              {settings.showGuide ? (
                <Eye className="h-3.5 w-3.5 text-muted-foreground" />
              ) : (
                <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />
              )}
              <p className="text-xs font-medium">Show guide lines in editor</p>
            </div>
            <ToggleButton
              active={settings.showGuide}
              onToggle={() => setProductPositioningSettings({ showGuide: !settings.showGuide })}
            />
          </div>

          <Separator />

          {/* Reset */}
          <Button
            variant="outline"
            size="sm"
            className="w-full text-xs gap-1.5"
            onClick={() => setProductPositioningSettings(DEFAULT_PRODUCT_POSITIONING_SETTINGS)}
          >
            <RotateCcw className="h-3 w-3" />
            Reset to defaults
          </Button>
        </>
      )}
    </div>
  )
}

// ─── Sub-components (same pattern as ai-product-mode-panel.tsx) ──────────────

function SliderField({
  label, value, min, max, step = 1, onChange, unit = '',
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  onChange: (v: number) => void
  unit?: string
}) {
  function commitNumber(raw: string) {
    const n = Number(raw)
    if (!Number.isFinite(n)) return
    onChange(Math.min(max, Math.max(min, n)))
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{label}</p>
        <span className="flex items-center gap-0.5">
          <input
            type="number"
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={e => commitNumber(e.target.value)}
            className="w-14 h-5 text-xs font-mono text-right bg-transparent border border-border rounded px-1
                       focus:outline-none focus:border-primary
                       [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          />
          <span className="text-xs font-mono text-muted-foreground">{unit}</span>
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
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