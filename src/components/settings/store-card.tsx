'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { RefreshCw, Store } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'

interface StoreCardProps {
  store: {
    id: string
    shop_name: string
    shop_domain: string
    currency: string
    last_synced_at: string | null
    is_active: boolean
  }
}

export function StoreCard({ store }: StoreCardProps) {
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState<string | null>(null)
  const router = useRouter()

  async function handleSync() {
    setSyncing(true)
    setSyncResult(null)

    const res = await fetch(`/api/stores/${store.id}/sync`, { method: 'POST' })
    const data = await res.json()

    if (res.ok) {
      setSyncResult(`Synced ${data.productsSync} products`)
      router.refresh()
    } else {
      setSyncResult(data.error || 'Sync failed')
    }
    setSyncing(false)
  }

  return (
    <Card>
      <CardContent className="p-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Store className="h-8 w-8 text-muted-foreground" />
          <div>
            <div className="flex items-center gap-2">
              <p className="font-medium text-sm">{store.shop_name || store.shop_domain}</p>
              <Badge variant={store.is_active ? 'default' : 'secondary'}>
                {store.is_active ? 'Active' : 'Inactive'}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">{store.shop_domain}</p>
            {store.last_synced_at && (
              <p className="text-xs text-muted-foreground">
                Last synced {formatDistanceToNow(new Date(store.last_synced_at), { addSuffix: true })}
              </p>
            )}
            {syncResult && <p className="text-xs text-green-600 mt-1">{syncResult}</p>}
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={handleSync} disabled={syncing}>
          <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${syncing ? 'animate-spin' : ''}`} />
          {syncing ? 'Syncing…' : 'Sync now'}
        </Button>
      </CardContent>
    </Card>
  )
}