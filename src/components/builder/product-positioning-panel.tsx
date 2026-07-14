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
  Tags,
} from 'lucide-react'

const SHOT_TYPE_LABELS: Record<ShotType, string> = {
  full_body:  'Full Body',
  half_body:  'Half Body',
  close_up:   'Close-up',
  detail:     'Detail',
  flat_lay:   'Flat Lay',
  accessory:  'Accessory',
}

// Only full-body shots are safe to auto-frame with head+feet detection.
// Half-body shots have no feet in frame — fill mode would zoom 3× into the waist.
const SAFE_DEFAULT_SHOT_TYPES: ShotType[] = ['full_body']

export function ProductPositioningPanel() {
  const { canvasData, setProductPositioningSettings } = useBuilderStore()

  const settings = canvasData.productPositioningSettings ?? DEFAULT_PRODUCT_POSITIONING_SETTINGS
  const maxHeadSpace = Math.round((canvasData.height || 1080) * 0.7)

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
      applyToShotTypes: settings.applyToShotTypes?.length
        ? settings.applyToShotTypes
        : SAFE_DEFAULT_SHOT_TYPES,
    })
  }

  function disable() {
    setProductPositioningSettings({ enabled: false })
  }

  function toggleShotType(type: ShotType) {
    const current = settings.applyToShotTypes ?? SAFE_DEFAULT_SHOT_TYPES
    const next = current.includes(type)
      ? current.filter(t => t !== type)
      : [...current, type]
    setProductPositioningSettings({ applyToShotTypes: next })
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
          Zoom and crop every full-body product so the model's head and feet
          hit the guide lines exactly. Other shot types are generated as-is.
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
          <p className="text-xs text-muted-foreground mt-0.5">Auto-frame products</p>
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
              <span className="text-xs text-muted-foreground ml-auto">distance from top</span>
            </div>
            <SliderField
              value={settings.headSpacePx}
              min={0} max={maxHeadSpace}
              onChange={v => setProductPositioningSettings({ headSpacePx: v })}
              unit="px"
            />
            <p className="text-xs text-muted-foreground">
              Model's head aligns to this line. The photo backdrop fills the space above it.
            </p>
          </div>

          <Separator />

          {/* Bottom Space */}
          <div className="space-y-3">
            <div className="flex items-center gap-1.5">
              <AlignVerticalJustifyEnd className="h-3.5 w-3.5 text-muted-foreground" />
              <p className="text-xs font-medium">Bottom Space</p>
              <span className="text-xs text-muted-foreground ml-auto">distance from bottom</span>
            </div>
            <SliderField
              value={settings.bottomMarginPx}
              min={0} max={600}
              onChange={v => setProductPositioningSettings({ bottomMarginPx: v })}
              unit="px"
            />
            <p className="text-xs text-muted-foreground">
              Model's feet (or hem) align to this line. Set to 0 to push feet to the canvas edge.
            </p>
          </div>

          <Separator />

          {/* Shot Types */}
          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <Tags className="h-3.5 w-3.5 text-muted-foreground" />
              <p className="text-xs font-medium">Apply to these shots</p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {SHOT_TYPES.map(type => {
                const active = (settings.applyToShotTypes ?? SAFE_DEFAULT_SHOT_TYPES).includes(type)
                return (
                  <button
                    key={type}
                    onClick={() => toggleShotType(type)}
                    className={`text-xs px-2.5 py-1 rounded-full border transition-all ${
                      active
                        ? 'border-primary bg-primary/5 text-primary font-medium'
                        : 'border-border text-muted-foreground hover:border-muted-foreground/40'
                    }`}
                  >
                    {SHOT_TYPE_LABELS[type]}
                  </button>
                )
              })}
            </div>
            <p className="text-xs text-muted-foreground leading-snug">
              Images whose shot type isn't selected are generated as-is — no zooming or cropping.
              <br />
              <span className="text-amber-600 dark:text-amber-400">
                ⚠ Avoid selecting Half Body, Close-up, Detail — they have no feet in frame and
                will produce extreme zoom-in results.
              </span>
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
                ? 'When the zoomed photo doesn\'t fully cover the canvas (narrow portrait on a wide canvas, or small side gaps), Cloudinary Generative Fill extends the background. Adds ~5s per image.'
                : 'Off — any uncovered canvas edges will show the canvas background color.'}
            </p>
          </div>

          <Separator />

          {/* Show guide lines */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              {settings.showGuide
                ? <Eye className="h-3.5 w-3.5 text-muted-foreground" />
                : <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />
              }
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
              applyToShotTypes: SAFE_DEFAULT_SHOT_TYPES,
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
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={min} max={max} step={step} value={value}
          onChange={e => onChange(Number(e.target.value))}
          className="flex-1 h-1.5 accent-primary cursor-pointer"
        />
        <span className="flex items-center gap-0.5 shrink-0">
          <input
            type="number"
            min={min} max={max} step={step} value={value}
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