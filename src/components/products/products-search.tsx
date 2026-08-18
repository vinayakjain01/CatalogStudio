'use client'

import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { useState, useTransition } from 'react'
import { Input } from '@/components/ui/input'
import { Search, X } from 'lucide-react'

/**
 * Commits on Enter or blur, not on every keystroke.
 *
 * A prior version of this component (never actually wired into the page —
 * found dangling and unused) debounced on a 400ms timer instead. Explicit
 * commit avoids firing a server round trip on every keystroke while the
 * merchant is still typing a longer product name, at the cost of one extra
 * keypress/blur to see results — a deliberate trade, not an oversight.
 */
export function ProductsSearch({ defaultValue }: { defaultValue?: string }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [value, setValue] = useState(defaultValue ?? '')
  const [isPending, startTransition] = useTransition()

  function commit(q: string) {
    const params = new URLSearchParams(searchParams.toString())
    if (q.trim()) {
      params.set('search', q.trim())
    } else {
      params.delete('search')
    }
    params.set('page', '1') // reset to page 1 on new search
    startTransition(() => router.push(`${pathname}?${params.toString()}`))
  }

  function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') commit(value)
  }

  function clear() {
    setValue('')
    commit('')
  }

  return (
    <div className="relative w-72">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        className="pl-9 pr-8"
        placeholder="Search products…"
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={handleKey}
        onBlur={() => commit(value)}
      />
      {value && (
        <button
          type="button"
          onClick={clear}
          aria-label="Clear search"
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      )}
      {isPending && (
        <span className="absolute right-8 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
          …
        </span>
      )}
    </div>
  )
}
