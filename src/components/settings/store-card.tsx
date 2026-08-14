'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { RefreshCw, Store, Copy, Check, ChevronDown, ChevronUp, AlertTriangle, ExternalLink } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'

interface StoreCardProps {
  store: {
    id: string
    shop_name: string
    shop_domain: string
    currency: string
    last_synced_at: string | null
    is_active: boolean
    feed_token: string
    needs_reauth?: boolean
  }
}

export function StoreCard({ store }: StoreCardProps) {
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState<string | null>(null)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [needsReauth, setNeedsReauth] = useState(store.needs_reauth ?? false)
  const [showFeed, setShowFeed] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const router = useRouter()

  const feedJsonUrl = `${process.env.NEXT_PUBLIC_APP_URL || ''}/api/feed/${store.id}?token=${store.feed_token}&format=json`
  const feedCsvUrl = `${process.env.NEXT_PUBLIC_APP_URL || ''}/api/feed/${store.id}?token=${store.feed_token}&format=csv`

  /**
   * Reconnect opens the app INSIDE the Shopify admin — it does not run the
   * legacy OAuth install flow.
   *
   * WHY: /admin/oauth/authorize + code grant returns a NON-EXPIRING offline
   * token (shpat_…), and the Admin API now rejects those outright:
   *   "[API] Non-expiring access tokens are no longer accepted."
   * Verified live — reconnecting that way swapped the token and still 403'd.
   *
   * The only path to an *expiring* offline token is token exchange, which needs
   * the session token App Bridge provides, which only exists when the app is
   * loaded embedded. Launching the admin app URL triggers
   * / → /api/shopify/auth?id_token=… → exchange → fresh token.
   */
  const storeHandle = store.shop_domain.replace(/\.myshopify\.com$/, '')
  const apiKey = process.env.NEXT_PUBLIC_SHOPIFY_CLIENT_ID
  const embeddedAppUrl = apiKey
    ? `https://admin.shopify.com/store/${storeHandle}/apps/${apiKey}`
    : null
  // Falls back to the install flow only when the app key isn't exposed to the
  // browser — a store that was never installed still needs that path.
  const reconnectUrl =
    embeddedAppUrl ?? `/api/shopify/install?shop=${encodeURIComponent(store.shop_domain)}`

  /**
   * Navigate the TOP window, never the current one. Inside the Shopify admin
   * this renders in an iframe, and both the admin and Shopify's OAuth screen
   * set frame-ancestors, so navigating the iframe dies silently — the merchant
   * clicks and nothing happens. Outside the iframe `top === self`, so this is
   * an ordinary navigation.
   */
  function startReconnect(e: React.MouseEvent) {
    e.preventDefault()
    const target = reconnectUrl.startsWith('http')
      ? reconnectUrl
      : `${window.location.origin}${reconnectUrl}`
    if (window.top && window.top !== window.self) {
      window.top.location.href = target
    } else {
      window.location.href = target
    }
  }

  async function handleSync() {
    setSyncing(true)
    setSyncResult(null)
    setSyncError(null)

    const res = await fetch(`/api/stores/${store.id}/sync`, { method: 'POST' })
    const data = await res.json()

    if (res.ok) {
      setSyncResult(`Synced ${data.productsSync} products`)
      setNeedsReauth(false)
      router.refresh()
    } else {
      if (data.needs_reauth) {
        setNeedsReauth(true)
        setSyncError('Your Shopify access token has expired and needs to be refreshed.')
      } else {
        setSyncError(data.error || 'Sync failed')
      }
    }
    setSyncing(false)
  }

  function copyToClipboard(text: string, key: string) {
    navigator.clipboard.writeText(text)
    setCopied(key)
    setTimeout(() => setCopied(null), 2000)
  }

  return (
    <Card className={needsReauth ? 'border-amber-300' : ''}>
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
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
              {store.last_synced_at && !needsReauth && (
                <p className="text-xs text-muted-foreground">
                  Last synced {formatDistanceToNow(new Date(store.last_synced_at), { addSuffix: true })}
                </p>
              )}
              {syncResult && <p className="text-xs text-green-600 mt-1">{syncResult}</p>}
              {syncError && !needsReauth && <p className="text-xs text-red-600 mt-1">{syncError}</p>}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {!needsReauth && (
              <Button variant="outline" size="sm" onClick={handleSync} disabled={syncing}>
                <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${syncing ? 'animate-spin' : ''}`} />
                {syncing ? 'Syncing…' : 'Sync now'}
              </Button>
            )}
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setShowFeed(!showFeed)}>
              {showFeed ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </Button>
          </div>
        </div>

        {/* Token expired / needs reconnect banner */}
        {needsReauth && (
          <div className="mt-3 flex items-start gap-3 p-3 rounded-md bg-amber-50 border border-amber-200">
            <AlertTriangle className="h-4 w-4 text-amber-600 flex-shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-amber-800">Shopify access token expired</p>
              <p className="text-xs text-amber-700 mt-0.5">
                Shopify only accepts expiring tokens now, and those are issued when the
                app is opened inside your Shopify admin. Reconnect opens it there and
                refreshes the token automatically.
              </p>
            </div>
            <Button size="sm" variant="outline" className="border-amber-400 text-amber-800 hover:bg-amber-100 flex-shrink-0" asChild>
              <a href={reconnectUrl} onClick={startReconnect}>
                <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                Reconnect
              </a>
            </Button>
          </div>
        )}

        {showFeed && (
          <div className="mt-4 pt-4 border-t space-y-3">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Feed URLs</p>

            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="text-xs flex-shrink-0">JSON</Badge>
                <code className="text-xs bg-muted px-2 py-1 rounded flex-1 truncate">{feedJsonUrl}</code>
                <Button variant="ghost" size="icon" className="h-7 w-7 flex-shrink-0" onClick={() => copyToClipboard(feedJsonUrl, 'json')}>
                  {copied === 'json' ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="text-xs flex-shrink-0">CSV</Badge>
                <code className="text-xs bg-muted px-2 py-1 rounded flex-1 truncate">{feedCsvUrl}</code>
                <Button variant="ghost" size="icon" className="h-7 w-7 flex-shrink-0" onClick={() => copyToClipboard(feedCsvUrl, 'csv')}>
                  {copied === 'csv' ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
                </Button>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Use these URLs in Phase 5 to connect to Meta Commerce Manager or Google Merchant Center.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}