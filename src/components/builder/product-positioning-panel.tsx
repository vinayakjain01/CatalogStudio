'use client'

import { useBuilderStore } from '@/stores/builder-store'
import { DEFAULT_PRODUCT_POSITIONING_SETTINGS, SHOT_TYPES, type ShotType } from '@/types/template'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import {
  AlignVerticalJustifyStart,
  AlignVerticalJustifyEnd,
  Sparkles,
  Eye,
  EyeOff,
  RotateCcw,
  Crop,
} from 'lucide-react'

export function ProductPositioningPanel() {
  const { canvasData, setProductPositioningSettings } = useBuilderStore()

  const settings = canvasData.productPositioningSettings ?? DEFAULT_PRODUCT_POSITIONING_SETTINGS
  const maxHeadSpace = Math.round((canvasData.height || 1080) * 0.7)
  const maxBottomSpace = 600

  function enable() {
    setProductPositioningSettings({
      ...DEFAULT_PRODUCT_POSITIONING_SETTINGS,
      enabled: true,
      scaleMode: 'fill',
      headSpacePx: settings.headSpacePx,
      bottomMarginPx: settings.bottomMarginPx,
      showGuide: settings.showGuide ?? true,
      aiExtend: settings.aiExtend ?? true,
      autoCenterHorizontally: true,
      leftMarginPx: 0,
      rightMarginPx: 0,
      // apply to ALL shot types so every product photo is normalized
      applyToShotTypes: [...SHOT_TYPES] as ShotType[],
    })
  }

  function disable() {
    setProductPositioningSettings({ enabled: false })
  }

  return (
    <div className="space-y-4 p-4">
      {/* Header */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-1.5">
          <Crop className="h-3.5 w-3.5 text-muted-foreground" />
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Auto Framing</p>
        </div>
        <p className="text-xs text-muted-foreground leading-snug">
          Zoom and crop every product so the model's head and feet hit the guide lines exactly.
          Background gets cropped from the sides — the product always fills the frame.
        </p>
      </div>

      {/* On / Off */}
      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={disable}
          className={`p-3 rounded-lg border text-left transition-all ${
            !settings.enabled
              ? 'border-primary bg-primary/5 text-primary'
              : 'border-border hover:border-muted-foreground/40'
          }`}
        >
          <p className="text-xs font-semibold">Off</p>
          <p className="text-xs text-muted-foreground mt-0.5">Manual layout</p>
        </button>
        <button
          onClick={enable}
          className={`p-3 rounded-lg border text-left transition-all ${
            settings.enabled
              ? 'border-primary bg-primary/5 text-primary'
              : 'border-border hover:border-muted-foreground/40'
          }`}
        >
          <p className="text-xs font-semibold">On</p>
          <p className="text-xs text-muted-foreground mt-0.5">Auto-frame all products</p>
        </button>
      </div>

      {settings.enabled && (
        <>
          <Separator />

          {/* Head Space */}
          <div className="space-y-3">
            <div className="flex items-center gap-1.5">
              <AlignVerticalJustifyStart className="h-3.5 w-3.5 text-muted-foreground" />
              <p className="text-xs font-medium">Head Space</p>
              <p className="text-xs text-muted-foreground ml-auto">distance from top</p>
            </div>
            <SliderField
              value={settings.headSpacePx}
              min={0} max={maxHeadSpace}
              onChange={v => setProductPositioningSettings({ headSpacePx: v })}
              unit="px"
            />
            <p className="text-xs text-muted-foreground">
              The model&apos;s head will touch this line. Space above is filled by the photo&apos;s own backdrop.
            </p>
          </div>

          <Separator />

          {/* Bottom Space */}
          <div className="space-y-3">
            <div className="flex items-center gap-1.5">
              <AlignVerticalJustifyEnd className="h-3.5 w-3.5 text-muted-foreground" />
              <p className="text-xs font-medium">Bottom Space</p>
              <p className="text-xs text-muted-foreground ml-auto">distance from bottom</p>
            </div>
            <SliderField
              value={settings.bottomMarginPx}
              min={0} max={maxBottomSpace}
              onChange={v => setProductPositioningSettings({ bottomMarginPx: v })}
              unit="px"
            />
            <p className="text-xs text-muted-foreground">
              The model&apos;s feet (or hem) will touch this line. Set to 0 to push feet to the canvas edge.
            </p>
          </div>

          <Separator />

          {/* AI Extend */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <Sparkles className="h-3.5 w-3.5 text-muted-foreground" />
                <p className="text-xs font-medium">AI Extend</p>
              </div>
              <ToggleButton
                active={settings.aiExtend !== false}
                onToggle={() => setProductPositioningSettings({ aiExtend: !(settings.aiExtend !== false) })}
              />
            </div>
            <p className="text-xs text-muted-foreground leading-snug">
              {settings.aiExtend !== false
                ? 'When the zoomed photo doesn\'t fully cover the canvas (e.g. narrow portrait on a wide canvas), Cloudinary Generative Fill extends the background seamlessly. Adds ~5s to generation.'
                : 'AI Extend is off — any gaps outside the photo edges will show the canvas background color.'}
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
            onClick={() => setProductPositioningSettings({
              ...DEFAULT_PRODUCT_POSITIONING_SETTINGS,
              enabled: true,
              scaleMode: 'fill',
              applyToShotTypes: [...SHOT_TYPES] as ShotType[],
            })}
          >
            <RotateCcw className="h-3 w-3" />
            Reset to defaults
          </Button>
        </>
      )}
    </div>
  )
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function SliderField({
  value, min, max, step = 1, onChange, unit = '',
}: {
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
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={e => onChange(Number(e.target.value))}
          className="flex-1 h-1.5 accent-primary cursor-pointer"
        />
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