'use client'

import { shopifyFetch } from '@/lib/shopify-token'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Store, Loader2 } from 'lucide-react'

interface StoreLite {
  id: string
  shop_name: string | null
  shop_domain: string
}

// Global store switcher. On change: persists the active store (cookie) then
// router.refresh() re-runs every server component with the new active store,
// so all pages/tables/metrics reload for the selected store with no stale data.
export function StoreSwitcher({
  stores,
  activeStoreId,
}: {
  stores: StoreLite[]
  activeStoreId: string | null
}) {
  const router = useRouter()
  const [switching, setSwitching] = useState(false)

  if (stores.length === 0) return null

  async function onChange(storeId: string) {
    if (storeId === activeStoreId) return
    setSwitching(true)
    try {
      await shopifyFetch('/api/active-store', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storeId }),
      })
      // Re-fetch all server components for the newly active store.
      router.refresh()
    } finally {
      setSwitching(false)
    }
  }

  return (
    <div className="px-3 py-2">
      <Select value={activeStoreId ?? undefined} onValueChange={onChange}>
        <SelectTrigger className="h-9 text-xs w-full">
          <div className="flex items-center gap-2 min-w-0">
            {switching
              ? <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
              : <Store className="h-3.5 w-3.5 shrink-0" />}
            <SelectValue placeholder="Select store" />
          </div>
        </SelectTrigger>
        <SelectContent>
          {stores.map(s => (
            <SelectItem key={s.id} value={s.id} className="text-xs">
              {s.shop_name || s.shop_domain}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}