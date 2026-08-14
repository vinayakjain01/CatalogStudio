import { cn } from '@/lib/utils'

/**
 * Inventory / sale status pill.
 *
 * Centralised because these colours carry meaning — red is "cannot be bought",
 * amber is "act soon" — and the same product state must never render green on
 * one screen and amber on another. The variants are exactly the ones in the
 * design spec.
 */
export type StatusTone = 'in_stock' | 'low_stock' | 'sold_out' | 'sale' | 'neutral'

/**
 * Warm teal / amber / coral rather than stock green-red, so status reads as
 * part of the palette instead of browser-default alerting. Each pairs its own
 * tinted background with a matching foreground, so a pill is legible in both
 * themes without per-usage overrides.
 */
const TONE: Record<StatusTone, string> = {
  in_stock:  'bg-success-bg text-success',
  low_stock: 'bg-warning-bg text-warning',
  sold_out:  'bg-danger-bg text-danger',
  // Sale is an announcement, not a state — solid so it reads as a label.
  sale:      'bg-danger text-white',
  neutral:   'bg-muted text-muted-foreground',
}

export function StatusBadge({
  tone,
  children,
  className,
}: {
  tone: StatusTone
  children: React.ReactNode
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        TONE[tone],
        className
      )}
    >
      {children}
    </span>
  )
}
