import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Empty state: illustration, headline, one sentence, one action.
 *
 * Deliberately never says "nothing here yet" — an empty screen already conveys
 * that. The headline states what the user can do and the CTA does it, so an
 * empty list is a starting point rather than a dead end.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon: LucideIcon
  title: string
  description?: string
  action?: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-xl border border-dashed bg-card px-6 py-16 text-center',
        className
      )}
    >
      {/* Concentric rings read as an illustration at a glance without shipping
          a bespoke asset per screen. */}
      <div className="relative mb-5 flex h-20 w-20 items-center justify-center">
        <span className="absolute inset-0 rounded-full bg-primary/5" />
        <span className="absolute inset-2 rounded-full bg-primary/10" />
        <Icon className="relative h-8 w-8 text-primary" strokeWidth={1.5} />
      </div>

      <h3 className="text-base font-semibold text-foreground">{title}</h3>
      {description && (
        <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">{description}</p>
      )}
      {action && <div className="mt-5 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  )
}
