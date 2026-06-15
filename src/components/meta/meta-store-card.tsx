'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Copy, Check, RefreshCw, Loader2, ExternalLink } from 'lucide-react'
import { toast } from 'sonner'

interface Store {
  id: string
  shop_name: string | null
  shop_domain: string
  feed_token: string
  meta_catalog_id: string | null
  meta_feed_status: string | null
  meta_feed_last_sync: string | null
}

interface Stats {
  products: number
  generated: number
  failed: number
  pendingJobs: number
}

export function MetaStoreCard({ store, stats }: { store: Store; stats: Stats }) {
  const router = useRouter()
  const [catalogId, setCatalogId] = useState(store.meta_catalog_id || '')
  const [saving, setSaving] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [copied, setCopied] = useState(false)

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || ''
  const feedUrl = `${appUrl}/api/meta/feed/${store.id}?token=${store.feed_token}`

  async function copyFeed() {
    await navigator.clipboard.writeText(feedUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  async function saveCatalog() {
    setSaving(true)
    try {
      const res = await fetch(`/api/meta/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storeId: store.id, metaCatalogId: catalogId.trim() || null }),
      })
      if (!res.ok) throw new Error((await res.json()).error || 'Save failed')
      toast.success('Catalog saved')
      router.refresh()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  async function syncNow() {
    setSyncing(true)
    try {
      const res = await fetch(`/api/stores/${store.id}/sync`, { method: 'POST' })
      if (!res.ok) throw new Error((await res.json()).error || 'Sync failed')
      toast.success('Sync started — creatives will generate in the background')
      router.refresh()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setSyncing(false)
    }
  }

  const statusColor =
    store.meta_feed_status === 'active' ? 'default'
    : store.meta_feed_status === 'not_connected' ? 'secondary'
    : 'secondary'

  return (
    <Card className="p-5 space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="font-medium">{store.shop_name || store.shop_domain}</h3>
          <p className="text-xs text-muted-foreground">{store.shop_domain}</p>
        </div>
        <Badge variant={statusColor as any}>
          {store.meta_feed_status === 'active' ? 'Feed active' : 'Not connected'}
        </Badge>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-3">
        <Stat label="Products" value={stats.products} />
        <Stat label="Creatives" value={stats.generated} />
        <Stat label="Failed" value={stats.failed} tone={stats.failed > 0 ? 'bad' : undefined} />
        <Stat label="In queue" value={stats.pendingJobs} tone={stats.pendingJobs > 0 ? 'busy' : undefined} />
      </div>

      {/* Catalog ID */}
      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">Meta Catalog ID</Label>
        <div className="flex gap-2">
          <Input
            value={catalogId}
            onChange={e => setCatalogId(e.target.value)}
            placeholder="e.g. 1234567890"
            className="h-8 text-xs"
          />
          <Button size="sm" className="h-8" onClick={saveCatalog} disabled={saving}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Save'}
          </Button>
        </div>
      </div>

      {/* Feed URL */}
      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">Catalog Feed URL (XML)</Label>
        <div className="flex gap-2">
          <Input readOnly value={feedUrl} className="h-8 text-xs font-mono" onFocus={e => e.target.select()} />
          <Button size="sm" variant="outline" className="h-8" onClick={copyFeed}>
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          In Commerce Manager → Catalog → Data Sources, choose <b>Add Items → Use a URL</b>,
          paste this link, and schedule it (e.g. hourly). Meta builds the full catalog from
          this feed, using your generated creatives as the product images.
          Last pulled: {store.meta_feed_last_sync ? new Date(store.meta_feed_last_sync).toLocaleString() : 'never'}
        </p>
      </div>

      {/* Actions */}
      <div className="flex gap-2 pt-1">
        <Button size="sm" variant="outline" className="h-8" onClick={syncNow} disabled={syncing}>
          {syncing ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
          Sync now
        </Button>
        <a href="https://business.facebook.com/commerce" target="_blank" rel="noreferrer">
          <Button size="sm" variant="ghost" className="h-8">
            <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
            Commerce Manager
          </Button>
        </a>
      </div>
    </Card>
  )
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'bad' | 'busy' }) {
  return (
    <div className="rounded-md border p-2 text-center">
      <div className={
        tone === 'bad' ? 'text-lg font-semibold text-destructive'
        : tone === 'busy' ? 'text-lg font-semibold text-amber-600'
        : 'text-lg font-semibold'
      }>
        {value.toLocaleString()}
      </div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  )
}