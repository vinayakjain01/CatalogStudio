'use client'

import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { cn } from '@/lib/utils'

const OPTIONS = [
  { value: 'all', label: 'All Products' },
  { value: 'in_stock', label: 'In Stock' },
] as const

type StockFilter = (typeof OPTIONS)[number]['value']

/**
 * Segmented pill next to the "Products" heading. Drives the `stock` search
 * param the page's own query reads (see products/page.tsx) rather than
 * filtering client-side — a client-side filter would only ever narrow the
 * current page's 10 rows, not the underlying result set or its pagination.
 */
export function StockToggle({ current }: { current: StockFilter }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  function select(value: StockFilter) {
    if (value === current) return
    const params = new URLSearchParams(searchParams.toString())
    if (value === 'all') params.delete('stock')
    else params.set('stock', value)
    params.set('page', '1') // reset to page 1 — the previous page may not exist in the new set
    router.push(`${pathname}?${params.toString()}`)
  }

  return (
    <div className="inline-flex shrink-0 rounded-full bg-muted p-0.5 text-sm">
      {OPTIONS.map(opt => (
        <button
          key={opt.value}
          type="button"
          onClick={() => select(opt.value)}
          aria-pressed={current === opt.value}
          className={cn(
            'rounded-full px-3 py-1 font-medium whitespace-nowrap transition-colors',
            current === opt.value
              ? 'bg-primary text-primary-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}
