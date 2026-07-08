'use client'

/**
 * ProductPositioningGuide
 *
 * Live canvas overlay visualising the Product Positioning configuration
 * (head-space line, margin bands, safe-area corner markers). Editor-only —
 * this component is never invoked from the server compositeImage() path, so
 * these guides never appear in an exported creative.
 *
 * Ported from the deleted HeadSpaceGuide.tsx (that visual design was fine;
 * only the underlying positioning logic needed the classification fix).
 */

import type { ProductPositioningSettings } from '@/types/template'

interface ProductPositioningGuideProps {
  settings: ProductPositioningSettings
  /** Display width of the canvas preview element in CSS pixels */
  displayW: number
  /** Display height of the canvas preview element in CSS pixels */
  displayH: number
  /** Logical canvas width (e.g. 1080) — used for scale calculation */
  canvasW: number
  /** Logical canvas height (e.g. 1080) */
  canvasH: number
}

export function ProductPositioningGuide({
  settings,
  displayW,
  displayH,
  canvasW,
  canvasH,
}: ProductPositioningGuideProps) {
  if (!settings.showGuide) return null

  const { headSpacePx, leftMarginPx, rightMarginPx, bottomMarginPx } = settings

  const scaleX = displayW / canvasW
  const scaleY = displayH / canvasH

  const headTopPx = headSpacePx * scaleY
  const leftPx = leftMarginPx * scaleX
  const rightPx = rightMarginPx * scaleX
  const bottomPx = bottomMarginPx * scaleY

  const corners = [
    { top: headTopPx - 3, left: leftPx - 3 },
    { top: headTopPx - 3, right: rightPx - 3 },
    { bottom: bottomPx - 3, left: leftPx - 3 },
    { bottom: bottomPx - 3, right: rightPx - 3 },
  ]

  return (
    <div className="absolute inset-0 pointer-events-none select-none" style={{ zIndex: 9999 }} aria-hidden="true">
      {/* Head Space band */}
      <div
        className="absolute top-0 left-0 right-0"
        style={{ height: headTopPx, background: 'rgba(99, 102, 241, 0.13)', borderBottom: '1.5px dashed rgba(99, 102, 241, 0.75)' }}
      >
        <span
          className="absolute left-1/2 -translate-x-1/2 font-mono font-semibold whitespace-nowrap"
          style={{ bottom: 3, fontSize: Math.max(7, Math.round(displayW * 0.013)), color: 'rgba(99, 102, 241, 0.95)', textShadow: '0 0 5px rgba(255,255,255,0.9)' }}
        >
          ↓ {headSpacePx}px head guide
        </span>
      </div>

      {/* Margins */}
      <div className="absolute top-0 bottom-0 left-0" style={{ width: leftPx, background: 'rgba(99, 102, 241, 0.06)', borderRight: '1px dashed rgba(99, 102, 241, 0.35)' }} />
      <div className="absolute top-0 bottom-0 right-0" style={{ width: rightPx, background: 'rgba(99, 102, 241, 0.06)', borderLeft: '1px dashed rgba(99, 102, 241, 0.35)' }} />
      <div className="absolute bottom-0 left-0 right-0" style={{ height: bottomPx, background: 'rgba(99, 102, 241, 0.06)', borderTop: '1px dashed rgba(99, 102, 241, 0.35)' }} />

      {/* Safe-area corner markers */}
      {corners.map((pos, i) => (
        <div key={i} className="absolute rounded-full" style={{ ...pos, width: 6, height: 6, background: 'rgba(99, 102, 241, 0.85)', boxShadow: '0 0 0 1.5px rgba(255,255,255,0.7)' }} />
      ))}

      {/* Scale mode badge */}
      {settings.scaleMode === 'smart_fit' && (
        <div
          className="absolute flex items-center gap-0.5 rounded px-1 py-0.5"
          style={{ right: rightPx + 4, top: headTopPx + 4, background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.25)' }}
        >
          <span className="font-semibold whitespace-nowrap" style={{ fontSize: Math.max(7, Math.round(displayW * 0.012)), color: 'rgba(99,102,241,0.9)' }}>
            ⤢ Smart Fit
          </span>
        </div>
      )}
    </div>
  )
}
