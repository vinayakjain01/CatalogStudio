import { cn } from '@/lib/utils'

/**
 * Craftify brand mark.
 *
 * Inline SVG rather than an image file: it stays crisp at any size, needs no
 * network request, and draws in `currentColor` so it inherits the theme instead
 * of needing a second asset for dark mode.
 *
 * The mark is a 2x2 grid — three tiles plus a spark in the fourth — reading as
 * a catalog of frames with one being generated.
 */
export function CraftifyMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      role="img"
      aria-label="Craftify"
      className={cn('h-8 w-8 text-primary', className)}
    >
      {/* Pale tiles — same hue at low opacity, so one colour drives the mark. */}
      <rect x="1"  y="1"  width="13" height="13" rx="4" fill="currentColor" opacity="0.18" />
      <rect x="1"  y="18" width="13" height="13" rx="4" fill="currentColor" opacity="0.18" />
      {/* The solid tile */}
      <rect x="18" y="1"  width="13" height="13" rx="4" fill="currentColor" />
      {/* The spark: a four-point star with concave sides */}
      <path
        d="M24.5 18c.45 3.4 2.6 5.55 6 6-3.4.45-5.55 2.6-6 6-.45-3.4-2.6-5.55-6-6 3.4-.45 5.55-2.6 6-6Z"
        fill="currentColor"
      />
    </svg>
  )
}

/**
 * Mark plus wordmark. `Fraunces` is inherited from the heading font, keeping
 * the logo consistent with page titles rather than introducing a third face.
 */
export function CraftifyLogo({
  className,
  markClassName,
  showWordmark = true,
}: {
  className?: string
  markClassName?: string
  showWordmark?: boolean
}) {
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      <CraftifyMark className={markClassName} />
      {showWordmark && (
        <span className="font-heading text-[19px] font-semibold tracking-tight text-primary">
          Craftify
        </span>
      )}
    </div>
  )
}
