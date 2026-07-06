'use client'

import { useBuilderStore } from '@/stores/builder-store'
import { DEFAULT_HEAD_SPACE_SETTINGS } from '@/types/template'
import { Separator } from '@/components/ui/separator'
import { Button } from '@/components/ui/button'
import {
  AlignVerticalJustifyStart, Move, RotateCcw, Sparkles, Info,
} from 'lucide-react'

export function HeadSpacePanel() {
  const { canvasData, setHeadSpaceSettings } = useBuilderStore()
  const settings = canvasData.headSpaceSettings ?? DEFAULT_HEAD_SPACE_SETTINGS
  const isAiMode = canvasData.templateMode === 'ai_product'

  return (
    <div className="space-y-4 p-4">

      {/* Header */}
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Head Space
        </p>

        {/* On / Off toggle */}
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
            <p className="text-xs text-muted-foreground mt-0.5">Default</p>
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
            <p className="text-xs text-muted-foreground mt-0.5">Align all products</p>
          </button>
        </div>
      </div>

      {settings.enabled && (
        <>
          {/* How it works for this template mode */}
          <div className={`rounded-lg p-3 text-xs space-y-1.5 ${
            isAiMode
              ? 'bg-green-50 dark:bg-green-950/30 text-green-800 dark:text-green-300'
              : 'bg-blue-50 dark:bg-blue-950/30 text-blue-800 dark:text-blue-300'
          }`}>
            {isAiMode ? (
              <>
                <div className="flex items-center gap-1.5 font-semibold">
                  <Sparkles className="h-3 w-3" />
                  AI Mode — precise alignment
                </div>
                <p className="leading-snug">
                  The visible product (after background removal) is detected pixel-by-pixel.
                  Its head will land exactly at <strong>{settings.headSpacePx}px</strong> from the canvas top, regardless of the original photo framing.
                </p>
              </>
            ) : (
              <>
                <div className="flex items-center gap-1.5 font-semibold">
                  <Info className="h-3 w-3" />
                  Standard Mode — consistent framing
                </div>
                <p className="leading-snug">
                  Every product photo starts at <strong>{settings.headSpacePx}px</strong> from the top and fills the canvas width. For exact head detection, enable AI Background Removal (AI tab).
                </p>
              </>
            )}
          </div>

          {/* Visual diagram */}
          <div className="relative rounded-md border bg-muted/20 mx-auto" style={{ width: 100, height: 120 }}>
            {/* Head space zone */}
            <div
              className="absolute top-0 left-0 right-0 bg-primary/15 border-b-2 border-dashed border-primary/60 flex items-center justify-center"
              style={{ height: (settings.headSpacePx / 400) * 60 + 8 }}
            >
              <span className="text-[7px] font-mono text-primary/80">{settings.headSpacePx}px</span>
            </div>
            {/* Product zone */}
            <div
              className="absolute left-0 right-0 bottom-0 bg-primary/8 flex items-center justify-center"
              style={{
                top: (settings.headSpacePx / 400) * 60 + 8,
                left: (settings.leftMarginPx / 200) * 20,
                right: (settings.rightMarginPx / 200) * 20,
                bottom: (settings.bottomMarginPx / 200) * 20,
              }}
            >
              <span className="text-[7px] text-primary/50">product</span>
            </div>
          </div>

          <Separator />

          {/* Spacing */}
          <div className="space-y-3">
            <div className="flex items-center gap-1.5">
              <AlignVerticalJustifyStart className="h-3.5 w-3.5 text-muted-foreground" />
              <p className="text-xs font-medium">Head Space</p>
            </div>
            <SliderField
              label="Top gap"
              value={settings.headSpacePx}
              min={0} max={400} unit="px"
              hint="Canvas top → top of product"
              onChange={v => setHeadSpaceSettings({ headSpacePx: v })}
            />
          </div>

          <Separator />

          {/* Margins */}
          <div className="space-y-3">
            <div className="flex items-center gap-1.5">
              <Move className="h-3.5 w-3.5 text-muted-foreground" />
              <p className="text-xs font-medium">Side Margins</p>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <SliderField label="Left"   value={settings.leftMarginPx}   min={0} max={200} unit="px" onChange={v => setHeadSpaceSettings({ leftMarginPx: v })} />
              <SliderField label="Right"  value={settings.rightMarginPx}  min={0} max={200} unit="px" onChange={v => setHeadSpaceSettings({ rightMarginPx: v })} />
              <SliderField label="Bottom" value={settings.bottomMarginPx} min={0} max={200} unit="px" onChange={v => setHeadSpaceSettings({ bottomMarginPx: v })} />
            </div>
          </div>

          <Separator />

          {/* Options */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">Auto-center horizontally</p>
              <Toggle active={settings.autoCenterHorizontally}
                onToggle={() => setHeadSpaceSettings({ autoCenterHorizontally: !settings.autoCenterHorizontally })} />
            </div>
          </div>

          <Separator />

          <Button variant="outline" size="sm" className="w-full text-xs"
            onClick={() => setHeadSpaceSettings({ ...DEFAULT_HEAD_SPACE_SETTINGS, enabled: true })}>
            <RotateCcw className="h-3 w-3 mr-1.5" />Reset to defaults
          </Button>
        </>
      )}
    </div>
  )
}

function SliderField({
  label, value, min, max, unit = '', hint, onChange,
}: {
  label: string; value: number; min: number; max: number
  unit?: string; hint?: string; onChange: (v: number) => void
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs text-muted-foreground">{label}</p>
          {hint && <p className="text-[10px] text-muted-foreground/60">{hint}</p>}
        </div>
        <span className="text-xs font-mono">{value}{unit}</span>
      </div>
      <input type="range" min={min} max={max} value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="w-full h-1.5 accent-primary cursor-pointer" />
    </div>
  )
}

function Toggle({ active, onToggle }: { active: boolean; onToggle: () => void }) {
  return (
    <button onClick={onToggle}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${active ? 'bg-primary' : 'bg-muted-foreground/30'}`}>
      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow-sm transition-transform ${active ? 'translate-x-4.5' : 'translate-x-0.5'}`} />
    </button>
  )
}