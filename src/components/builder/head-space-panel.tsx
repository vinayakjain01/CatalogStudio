'use client'

/**
 * Head Space Panel — v2
 *
 * Full panel UI for the AI Head Space Alignment system.
 * Renders inside the right-panel "Space" tab of the Template Builder.
 *
 * Sections:
 *   1. Enable / Disable toggle
 *   2. Head Guide Position slider
 *   3. Smart Auto Zoom toggle
 *   4. Allow AI Extend toggle
 *   5. Protect Full Product toggle
 *   6. Side Margins (Left / Right / Bottom)
 *   7. Preview Guide toggle
 *   8. Reset to defaults
 *
 * All settings are stored in canvasData.headSpaceSettings and
 * automatically applied during both single-generate and bulk-generate.
 */

import { useBuilderStore } from '@/stores/builder-store'
import { DEFAULT_HEAD_SPACE_SETTINGS } from '@/types/template'
import { Separator } from '@/components/ui/separator'
import { Button } from '@/components/ui/button'
import {
  AlignVerticalJustifyStart,
  Move,
  RotateCcw,
  Sparkles,
  Info,
  ZoomIn,
  Layers,
  Shield,
  Eye,
  EyeOff,
} from 'lucide-react'

export function HeadSpacePanel() {
  const { canvasData, setHeadSpaceSettings } = useBuilderStore()
  const settings = canvasData.headSpaceSettings ?? DEFAULT_HEAD_SPACE_SETTINGS
  const isAiMode = canvasData.templateMode === 'ai_product'

  // ── Section visibility ─────────────────────────────────────────────────────
  // When disabled, only the On/Off switcher is shown.
  // All detailed controls only appear when enabled.

  return (
    <div className="space-y-4 p-4">

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="space-y-1.5">
        <p className="text-xs font-semibold text-foreground uppercase tracking-widest">
          Head Space
        </p>
        <p className="text-[10px] text-muted-foreground leading-snug">
          Align every product at the same head position — like Zara, H&M, Myntra.
        </p>
      </div>

      {/* ── Enable / Disable ─────────────────────────────────────────────────── */}
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
          <p className="text-[10px] text-muted-foreground mt-0.5">Default behaviour</p>
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
          <p className="text-[10px] text-muted-foreground mt-0.5">Align all products</p>
        </button>
      </div>

      {/* ── Detailed controls (only when enabled) ──────────────────────────── */}
      {settings.enabled && (
        <>
          {/* Mode explanation */}
          <div className={`rounded-lg p-3 text-xs space-y-1.5 ${
            isAiMode
              ? 'bg-green-50 dark:bg-green-950/30 text-green-800 dark:text-green-300'
              : 'bg-blue-50 dark:bg-blue-950/30 text-blue-800 dark:text-blue-300'
          }`}>
            {isAiMode ? (
              <>
                <div className="flex items-center gap-1.5 font-semibold">
                  <Sparkles className="h-3 w-3" />
                  AI Mode — pixel-precise detection
                </div>
                <p className="leading-snug text-[10px]">
                  The visible model (after background removal) is detected
                  pixel-by-pixel. Head lands exactly at <strong>{settings.headSpacePx}px</strong>.
                  Dupatta, saree, lehenga and accessories are never cropped.
                </p>
              </>
            ) : (
              <>
                <div className="flex items-center gap-1.5 font-semibold">
                  <Info className="h-3 w-3" />
                  Standard Mode — consistent framing
                </div>
                <p className="leading-snug text-[10px]">
                  Every product photo starts at <strong>{settings.headSpacePx}px</strong> from
                  the top. Enable AI Background Removal (AI tab) for exact head detection.
                </p>
              </>
            )}
          </div>

          {/* Visual diagram — mini canvas representation */}
          <HeadSpaceDiagram settings={settings} />

          <Separator />

          {/* ── 1. Head Guide Position ──────────────────────────────────────── */}
          <div className="space-y-3">
            <div className="flex items-center gap-1.5">
              <AlignVerticalJustifyStart className="h-3.5 w-3.5 text-muted-foreground" />
              <p className="text-xs font-medium">Head Guide Position</p>
            </div>
            <SliderField
              label="Distance from top"
              value={settings.headSpacePx}
              min={0}
              max={canvasData.height ? Math.round(canvasData.height * 0.4) : 400}
              unit="px"
              hint="Canvas top → top of head"
              onChange={v => setHeadSpaceSettings({ headSpacePx: v })}
            />
          </div>

          <Separator />

          {/* ── 2. Smart Auto Zoom ──────────────────────────────────────────── */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <ZoomIn className="h-3.5 w-3.5 text-muted-foreground" />
                <div>
                  <p className="text-xs font-medium">Smart Auto Zoom</p>
                  <p className="text-[10px] text-muted-foreground">
                    Scale product to fill available height
                  </p>
                </div>
              </div>
              <Toggle
                active={settings.autoZoom ?? true}
                onToggle={() => setHeadSpaceSettings({ autoZoom: !(settings.autoZoom ?? true) })}
              />
            </div>
            {(settings.autoZoom ?? true) && (
              <p className="text-[10px] text-muted-foreground bg-muted/50 rounded p-2 leading-snug">
                Every model will be the same height in the catalog.
                The head always touches the guide line, regardless of the
                original photo framing or camera distance.
              </p>
            )}
            {!(settings.autoZoom ?? true) && (
              <p className="text-[10px] text-muted-foreground bg-muted/50 rounded p-2 leading-snug">
                Legacy mode: product is scaled to fit inside the available area.
                Models will appear at different heights if photos have different
                amounts of white space.
              </p>
            )}
          </div>

          <Separator />

          {/* ── 3. Allow AI Extend ──────────────────────────────────────────── */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <Layers className="h-3.5 w-3.5 text-muted-foreground" />
                <div>
                  <p className="text-xs font-medium">Allow AI Extend</p>
                  <p className="text-[10px] text-muted-foreground">
                    Fill overflow with AI background
                  </p>
                </div>
              </div>
              <Toggle
                active={settings.allowAiExtend ?? true}
                onToggle={() => setHeadSpaceSettings({ allowAiExtend: !(settings.allowAiExtend ?? true) })}
              />
            </div>
            {(settings.allowAiExtend ?? true) && (
              <p className="text-[10px] text-muted-foreground bg-muted/50 rounded p-2 leading-snug">
                When zoom causes the product to overflow the canvas,
                AI automatically extends the background. Dupatta, saree,
                and accessories are never cropped.
              </p>
            )}
          </div>

          <Separator />

          {/* ── 4. Protect Full Product ─────────────────────────────────────── */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <Shield className="h-3.5 w-3.5 text-muted-foreground" />
                <div>
                  <p className="text-xs font-medium">Protect Full Product</p>
                  <p className="text-[10px] text-muted-foreground">
                    Never crop any part of the product
                  </p>
                </div>
              </div>
              <Toggle
                active={settings.protectFullProduct ?? true}
                onToggle={() => setHeadSpaceSettings({ protectFullProduct: !(settings.protectFullProduct ?? true) })}
              />
            </div>
            {(settings.protectFullProduct ?? true) && (
              <p className="text-[10px] text-muted-foreground bg-muted/50 rounded p-2 leading-snug">
                If Auto Zoom would still cause overflow even after AI Extend,
                the zoom is reduced so the full product remains visible.
              </p>
            )}
          </div>

          <Separator />

          {/* ── 5. Margins ──────────────────────────────────────────────────── */}
          <div className="space-y-3">
            <div className="flex items-center gap-1.5">
              <Move className="h-3.5 w-3.5 text-muted-foreground" />
              <p className="text-xs font-medium">Safe Area Margins</p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <SliderField
                label="Left"
                value={settings.leftMarginPx}
                min={0} max={200} unit="px"
                onChange={v => setHeadSpaceSettings({ leftMarginPx: v })}
              />
              <SliderField
                label="Right"
                value={settings.rightMarginPx}
                min={0} max={200} unit="px"
                onChange={v => setHeadSpaceSettings({ rightMarginPx: v })}
              />
            </div>
            <SliderField
              label="Bottom"
              value={settings.bottomMarginPx}
              min={0} max={200} unit="px"
              onChange={v => setHeadSpaceSettings({ bottomMarginPx: v })}
            />
          </div>

          <Separator />

          {/* ── 6. Preview Guide ────────────────────────────────────────────── */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              {(settings.showGuide ?? true)
                ? <Eye className="h-3.5 w-3.5 text-muted-foreground" />
                : <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />
              }
              <p className="text-xs font-medium">Preview Guide Line</p>
            </div>
            <Toggle
              active={settings.showGuide ?? true}
              onToggle={() => setHeadSpaceSettings({ showGuide: !(settings.showGuide ?? true) })}
            />
          </div>

          <Separator />

          {/* ── 7. Auto-center ──────────────────────────────────────────────── */}
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">Auto-center horizontally</p>
            <Toggle
              active={settings.autoCenterHorizontally}
              onToggle={() => setHeadSpaceSettings({ autoCenterHorizontally: !settings.autoCenterHorizontally })}
            />
          </div>

          <Separator />

          {/* ── Reset ───────────────────────────────────────────────────────── */}
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

// ─── Visual Diagram ────────────────────────────────────────────────────────────
// Mini canvas representation showing head space zone, product zone, and margins.

import type { HeadSpaceSettings } from '@/types/template'

function HeadSpaceDiagram({ settings }: { settings: HeadSpaceSettings }) {
  const diagramH = 130
  const diagramW = 100

  // Map headSpacePx to diagram space (assume 1080px canvas)
  const headZoneH = Math.max(4, Math.round((settings.headSpacePx / 1080) * diagramH))
  const marginLeft = Math.max(1, Math.round((settings.leftMarginPx / 1080) * diagramW))
  const marginRight = Math.max(1, Math.round((settings.rightMarginPx / 1080) * diagramW))
  const marginBottom = Math.max(1, Math.round((settings.bottomMarginPx / 1080) * diagramH))

  return (
    <div
      className="relative rounded-md border bg-muted/20 mx-auto overflow-hidden flex-shrink-0"
      style={{ width: diagramW, height: diagramH }}
    >
      {/* Head space zone — top tinted area */}
      <div
        className="absolute top-0 left-0 right-0 bg-primary/20 flex items-center justify-center"
        style={{
          height: headZoneH,
          borderBottom: '1.5px dashed rgba(99,102,241,0.7)',
        }}
      >
        <span className="text-[6px] font-mono text-primary/90 leading-none">
          {settings.headSpacePx}px
        </span>
      </div>

      {/* Left margin */}
      <div
        className="absolute top-0 bottom-0 left-0 bg-primary/8"
        style={{ width: marginLeft, borderRight: '1px dashed rgba(99,102,241,0.3)' }}
      />

      {/* Right margin */}
      <div
        className="absolute top-0 bottom-0 right-0 bg-primary/8"
        style={{ width: marginRight, borderLeft: '1px dashed rgba(99,102,241,0.3)' }}
      />

      {/* Bottom margin */}
      <div
        className="absolute bottom-0 left-0 right-0 bg-primary/8"
        style={{ height: marginBottom, borderTop: '1px dashed rgba(99,102,241,0.3)' }}
      />

      {/* Product zone label */}
      <div
        className="absolute flex items-center justify-center"
        style={{
          top: headZoneH,
          left: marginLeft,
          right: marginRight,
          bottom: marginBottom,
        }}
      >
        <span className="text-[7px] text-primary/40 font-medium">product</span>
      </div>

      {/* Corner dots */}
      {[
        { top: headZoneH - 3,           left: marginLeft - 3 },
        { top: headZoneH - 3,           right: marginRight - 3 },
        { bottom: marginBottom - 3,     left: marginLeft - 3 },
        { bottom: marginBottom - 3,     right: marginRight - 3 },
      ].map((pos, i) => (
        <div
          key={i}
          className="absolute w-1.5 h-1.5 rounded-full bg-primary/70"
          style={pos}
        />
      ))}
    </div>
  )
}

// ─── Shared Primitives ─────────────────────────────────────────────────────────

function SliderField({
  label,
  value,
  min,
  max,
  unit = '',
  hint,
  onChange,
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
        <span className="text-xs font-mono tabular-nums">
          {value}
          {unit}
        </span>
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

function Toggle({ active, onToggle }: { active: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors ${
        active ? 'bg-primary' : 'bg-muted-foreground/30'
      }`}
      aria-checked={active}
      role="switch"
    >
      <span
        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow-sm transition-transform ${
          active ? 'translate-x-[18px]' : 'translate-x-[2px]'
        }`}
      />
    </button>
  )
}