'use client'

import { useBuilderStore } from '@/stores/builder-store'
import { DEFAULT_HEAD_SPACE_SETTINGS } from '@/types/template'
import { Separator } from '@/components/ui/separator'
import { Button } from '@/components/ui/button'
import { AlignVerticalJustifyStart, Move, Info, RotateCcw } from 'lucide-react'

export function HeadSpacePanel() {
  const { canvasData, setHeadSpaceSettings } = useBuilderStore()
  const settings = canvasData.headSpaceSettings ?? DEFAULT_HEAD_SPACE_SETTINGS

  return (
    <div className="space-y-4 p-4">

      {/* Enable toggle */}
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Head Space
        </p>
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => setHeadSpaceSettings({ enabled: false })}
            className={`p-3 rounded-lg border text-left transition-all ${
              !settings.enabled
                ? 'border-primary bg-primary/5 text-primary'
                : 'border-border hover:border-muted-foreground/40'
            }`}
          >
            <p className="text-xs font-semibold">Off</p>
            <p className="text-xs text-muted-foreground mt-0.5">Default placement</p>
          </button>
          <button
            onClick={() => setHeadSpaceSettings({ enabled: true })}
            className={`p-3 rounded-lg border text-left transition-all ${
              settings.enabled
                ? 'border-primary bg-primary/5 text-primary'
                : 'border-border hover:border-muted-foreground/40'
            }`}
          >
            <div className="flex items-center gap-1.5">
              <p className="text-xs font-semibold">On</p>
              <AlignVerticalJustifyStart className="h-3 w-3" />
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">Consistent alignment</p>
          </button>
        </div>
      </div>

      {settings.enabled && (
        <>
          {/* Info */}
          <div className="flex gap-2 p-2.5 rounded-lg bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-300">
            <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <p className="text-xs leading-snug">
              Every product will be placed so exactly <strong>{settings.headSpacePx}px</strong> appears between the canvas top and the top of the visible product. Bulk creatives will be perfectly aligned.
            </p>
          </div>

          <Separator />

          {/* Head Space */}
          <div className="space-y-3">
            <div className="flex items-center gap-1.5">
              <AlignVerticalJustifyStart className="h-3.5 w-3.5 text-muted-foreground" />
              <p className="text-xs font-medium">Spacing</p>
            </div>

            <SliderField
              label="Head Space"
              value={settings.headSpacePx}
              min={0} max={400}
              unit="px"
              hint="Top of canvas → top of product"
              onChange={v => setHeadSpaceSettings({ headSpacePx: v })}
            />
          </div>

          <Separator />

          {/* Margins */}
          <div className="space-y-3">
            <div className="flex items-center gap-1.5">
              <Move className="h-3.5 w-3.5 text-muted-foreground" />
              <p className="text-xs font-medium">Safe Margins</p>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <SliderField
                label="Left"
                value={settings.leftMarginPx}
                min={0} max={200}
                unit="px"
                onChange={v => setHeadSpaceSettings({ leftMarginPx: v })}
              />
              <SliderField
                label="Right"
                value={settings.rightMarginPx}
                min={0} max={200}
                unit="px"
                onChange={v => setHeadSpaceSettings({ rightMarginPx: v })}
              />
              <SliderField
                label="Bottom"
                value={settings.bottomMarginPx}
                min={0} max={200}
                unit="px"
                onChange={v => setHeadSpaceSettings({ bottomMarginPx: v })}
              />
            </div>

            {/* Visual diagram */}
            <div className="relative rounded-md border bg-muted/30 aspect-square max-w-36 mx-auto">
              <div className="absolute inset-0 flex items-center justify-center">
                <div
                  className="bg-primary/20 border border-primary/40 rounded flex items-center justify-center"
                  style={{
                    position: 'absolute',
                    top: `${(settings.headSpacePx / 400) * 50 + 10}%`,
                    left: `${(settings.leftMarginPx / 200) * 25 + 5}%`,
                    right: `${(settings.rightMarginPx / 200) * 25 + 5}%`,
                    bottom: `${(settings.bottomMarginPx / 200) * 25 + 5}%`,
                  }}
                >
                  <span className="text-[8px] text-primary/70">product</span>
                </div>
              </div>
              {/* Top arrow */}
              <div className="absolute left-1/2 -translate-x-1/2 text-[7px] text-primary font-mono"
                style={{ top: '2px' }}>
                {settings.headSpacePx}px
              </div>
            </div>
          </div>

          <Separator />

          {/* Options */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">Auto-center horizontally</p>
              <ToggleButton
                active={settings.autoCenterHorizontally}
                onToggle={() => setHeadSpaceSettings({ autoCenterHorizontally: !settings.autoCenterHorizontally })}
              />
            </div>
          </div>

          <Separator />

          {/* Reset */}
          <Button
            variant="outline"
            size="sm"
            className="w-full text-xs"
            onClick={() => setHeadSpaceSettings({ ...DEFAULT_HEAD_SPACE_SETTINGS, enabled: true })}
          >
            <RotateCcw className="h-3 w-3 mr-1.5" />
            Reset to defaults
          </Button>
        </>
      )}
    </div>
  )
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SliderField({
  label, value, min, max, unit = '', hint, onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  unit?: string
  hint?: string
  onChange: (v: number) => void
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs text-muted-foreground">{label}</p>
          {hint && <p className="text-[10px] text-muted-foreground/60">{hint}</p>}
        </div>
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
      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform shadow-sm ${
        active ? 'translate-x-4.5' : 'translate-x-0.5'
      }`} />
    </button>
  )
}