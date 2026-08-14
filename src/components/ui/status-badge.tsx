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

const TONE: Record<StatusTone, string> = {
  in_stock:  'bg-green-100 text-green-800 dark:bg-green-950/40 dark:text-green-300',
  low_stock: 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300',
  sold_out:  'bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300',
  // Sale is an announcement, not a state — solid red so it reads as a label.
  sale:      'bg-red-600 text-white',
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
