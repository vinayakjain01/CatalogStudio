'use client'

/**
 * HeadSpaceGuide — v2
 *
 * Live canvas overlay that visualises the head space configuration.
 * Rendered on top of the CanvasPreview when headSpaceSettings.enabled is true
 * AND settings.showGuide is true.
 *
 * Shows:
 *   - Head Space band (purple tint, dashed bottom border = the guide line)
 *   - Left / Right / Bottom margin bands
 *   - Safe-area corner markers
 *   - Product bounding box (if a preview product is loaded and has an image)
 *
 * All coordinates are in CSS pixels (display space), scaled from the logical
 * canvas dimensions (e.g. 1080px) down to the preview size.
 */

import type { HeadSpaceSettings } from '@/types/template'

interface HeadSpaceGuideProps {
  settings: HeadSpaceSettings
  /** Display width of the canvas preview element in CSS pixels */
  displayW: number
  /** Display height of the canvas preview element in CSS pixels */
  displayH: number
  /** Logical canvas width (e.g. 1080) — used for scale calculation */
  canvasW?: number
  /** Logical canvas height (e.g. 1080) */
  canvasH?: number
}

export function HeadSpaceGuide({
  settings,
  displayW,
  displayH,
  canvasW = 1080,
  canvasH = 1080,
}: HeadSpaceGuideProps) {
  // When showGuide is explicitly false, render nothing
  if (!(settings.showGuide ?? true)) return null

  const { headSpacePx, leftMarginPx, rightMarginPx, bottomMarginPx } = settings

  // Scale from canvas logical px → display px
  const scaleX = displayW / canvasW
  const scaleY = displayH / canvasH

  const headTopPx  = headSpacePx   * scaleY
  const leftPx     = leftMarginPx  * scaleX
  const rightPx    = rightMarginPx * scaleX
  const bottomPx   = bottomMarginPx * scaleY

  // Corner positions for the safe-area dot markers
  const corners = [
    { top: headTopPx - 3,             left: leftPx  - 3             },
    { top: headTopPx - 3,             right: rightPx - 3            },
    { bottom: bottomPx - 3,           left: leftPx  - 3             },
    { bottom: bottomPx - 3,           right: rightPx - 3            },
  ]

  return (
    <div
      className="absolute inset-0 pointer-events-none select-none"
      style={{ zIndex: 9999 }}
      aria-hidden="true"
    >
      {/* ── Head Space Band ─────────────────────────────────────────────────── */}
      {/* This is the zone above the guide line — the "head space" */}
      <div
        className="absolute top-0 left-0 right-0"
        style={{
          height: headTopPx,
          background: 'rgba(99, 102, 241, 0.13)',
          borderBottom: '1.5px dashed rgba(99, 102, 241, 0.75)',
        }}
      >
        {/* Guide line label — positioned at the dashed line */}
        <span
          className="absolute left-1/2 -translate-x-1/2 font-mono font-semibold whitespace-nowrap"
          style={{
            bottom: 3,
            fontSize: Math.max(7, Math.round(displayW * 0.013)),
            color: 'rgba(99, 102, 241, 0.95)',
            textShadow: '0 0 5px rgba(255,255,255,0.9)',
          }}
        >
          ↓ {headSpacePx}px head guide
        </span>
      </div>

      {/* ── Left Margin ─────────────────────────────────────────────────────── */}
      <div
        className="absolute top-0 bottom-0 left-0"
        style={{
          width: leftPx,
          background: 'rgba(99, 102, 241, 0.06)',
          borderRight: '1px dashed rgba(99, 102, 241, 0.35)',
        }}
      />

      {/* ── Right Margin ────────────────────────────────────────────────────── */}
      <div
        className="absolute top-0 bottom-0 right-0"
        style={{
          width: rightPx,
          background: 'rgba(99, 102, 241, 0.06)',
          borderLeft: '1px dashed rgba(99, 102, 241, 0.35)',
        }}
      />

      {/* ── Bottom Margin ───────────────────────────────────────────────────── */}
      <div
        className="absolute bottom-0 left-0 right-0"
        style={{
          height: bottomPx,
          background: 'rgba(99, 102, 241, 0.06)',
          borderTop: '1px dashed rgba(99, 102, 241, 0.35)',
        }}
      />

      {/* ── Safe-area corner markers ─────────────────────────────────────────── */}
      {corners.map((pos, i) => (
        <div
          key={i}
          className="absolute rounded-full"
          style={{
            ...pos,
            width: 6,
            height: 6,
            background: 'rgba(99, 102, 241, 0.85)',
            boxShadow: '0 0 0 1.5px rgba(255,255,255,0.7)',
          }}
        />
      ))}

      {/* ── Auto-zoom / AI Extend status badge ──────────────────────────────── */}
      {(settings.autoZoom ?? true) && (
        <div
          className="absolute flex items-center gap-0.5 rounded px-1 py-0.5"
          style={{
            right: rightPx + 4,
            top: headTopPx + 4,
            background: 'rgba(99,102,241,0.1)',
            border: '1px solid rgba(99,102,241,0.25)',
          }}
        >
          <span
            className="font-semibold whitespace-nowrap"
            style={{
              fontSize: Math.max(7, Math.round(displayW * 0.012)),
              color: 'rgba(99,102,241,0.9)',
            }}
          >
            ⤢ Auto Zoom
          </span>
          {(settings.allowAiExtend ?? true) && (
            <span
              style={{
                fontSize: Math.max(7, Math.round(displayW * 0.011)),
                color: 'rgba(99,102,241,0.7)',
              }}
            >
              + AI Extend
            </span>
          )}
        </div>
      )}
    </div>
  )
}