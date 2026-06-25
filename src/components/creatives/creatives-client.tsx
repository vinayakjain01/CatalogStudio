'use client'

import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Wand2, Download, Trash2, RefreshCw, ImageIcon, Loader2 } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'

interface Creative {
  id: string
  generated_url: string
  status: string
  updated_at: string
  template_id: string
  cloudinary_public_id: string
  products: {
    title: string
    price: number
    product_images: { src: string }[]
  }
  templates: { name: string }
}

const FILTER_TYPES = [
  { value: 'all', label: 'All products' },
  { value: 'tag', label: 'By tag' },
  { value: 'vendor', label: 'By vendor' },
  { value: 'product_type', label: 'By product type' },
]

export function CreativesClient({ stores }: { stores: { id: string; shop_name: string; shop_domain: string }[] }) {
  const [selectedStore, setSelectedStore] = useState(stores[0]?.id || '')
  const [creatives, setCreatives] = useState<Creative[]>([])
  const [loading, setLoading] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [filterType, setFilterType] = useState('all')
  const [filterValue, setFilterValue] = useState('')
  const [genResult, setGenResult] = useState<string | null>(null)
  const [page, setPage] = useState(0)
  const [totalCreatives, setTotalCreatives] = useState(0)
  const [stats, setStats] = useState<{ matched: number; generated: number; pending: number } | null>(null)

  const PER_PAGE = 10

  useEffect(() => {
    if (selectedStore) { setPage(0); fetchStats() }
  }, [selectedStore])

  useEffect(() => {
    if (selectedStore) fetchCreatives()
  }, [selectedStore, page])

  // How many products match a rule, how many have a creative, how many remain.
  async function fetchStats() {
    if (!selectedStore) return
    try {
      const r = await fetch(`/api/generate/stats?storeId=${selectedStore}`)
      if (r.ok) setStats(await r.json())
    } catch { /* non-fatal */ }
  }

  async function fetchCreatives() {
    setLoading(true)
    const supabase = (await import('@/lib/supabase/client')).createClient()

    const fromRow = page * PER_PAGE
    const toRow = fromRow + PER_PAGE - 1

    const { data, count } = await supabase
      .from('generated_images')
      .select(`
        id, generated_url, status, updated_at, template_id, cloudinary_public_id,
        products!inner(title, price, store_id, product_images(src, is_primary)),
        templates(name)
      `, { count: 'exact' })
      .eq('products.store_id', selectedStore)
      .eq('status', 'completed')
      .order('updated_at', { ascending: false })
      .range(fromRow, toRow)

    setCreatives((data as any) || [])
    setTotalCreatives(count || 0)
    setLoading(false)
  }

  async function handleGenerate() {
    setGenerating(true)
    setGenResult(null)

    // Enqueue the run — returns instantly. The DigitalOcean worker (via Redis)
    // does the heavy compositing, so this no longer times out on large catalogs.
    const res = await fetch('/api/generate/enqueue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        storeId: selectedStore,
        filter: filterType === 'all' ? { type: 'all' } : { type: filterType, value: filterValue },
      }),
    })

    const data = await res.json()
    if (!res.ok) {
      setGenResult(data.error || 'Generation failed')
      setGenerating(false)
      return
    }

    if (!data.enqueued) {
      setGenResult(data.message || 'No products matched the rules.')
      setGenerating(false)
      return
    }

    const batchId = data.batchId
    setGenResult(`Queued ${data.enqueued} products. Generating…`)

    // The DigitalOcean worker consumes the Redis queue and processes jobs.
    // The browser just polls progress — no drain call needed.
    const tick = async (): Promise<void> => {
      const pr = await fetch(`/api/generate/enqueue?batchId=${batchId}`)
      const c = await pr.json()
      const done = (c.completed || 0) + (c.failed || 0)
      setGenResult(`Generating… ${done}/${c.total} done`)
      fetchCreatives()
      fetchStats()

      if (c.total > 0 && done < c.total) {
        setTimeout(tick, 2000)
      } else {
        setGenResult(`Done. ${c.completed} created${c.failed ? `, ${c.failed} failed` : ''}.`)
        fetchCreatives()
        fetchStats()
        setGenerating(false)
      }
    }
    tick()
  }

  async function handleDelete(creativeId: string, publicId: string) {
    if (!confirm('Delete this creative?')) return
    await fetch(`/api/creatives/${creativeId}`, { method: 'DELETE' })
    setCreatives(prev => prev.filter(c => c.id !== creativeId))
  }

  if (stores.length === 0) {
    return <p className="text-muted-foreground">No stores connected.</p>
  }

  return (
    <div className="space-y-6">
      {/* Generate controls */}
      <Card>
        <CardContent className="p-4 space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            {stores.length > 1 && (
              <Select value={selectedStore} onValueChange={setSelectedStore}>
                <SelectTrigger className="w-52">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {stores.map(s => (
                    <SelectItem key={s.id} value={s.id}>{s.shop_name || s.shop_domain}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            <Select value={filterType} onValueChange={v => { setFilterType(v); setFilterValue('') }}>
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FILTER_TYPES.map(f => (
                  <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            {filterType !== 'all' && (
              <Input
                placeholder={`Enter ${filterType}…`}
                value={filterValue}
                onChange={e => setFilterValue(e.target.value)}
                className="w-44 h-9"
              />
            )}

            <Button onClick={handleGenerate} disabled={generating || (filterType !== 'all' && !filterValue)}>
              {generating
                ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Generating…</>
                : <><Wand2 className="h-4 w-4 mr-2" />Generate creatives</>
              }
            </Button>
          </div>

          {genResult && (
            <p className="text-sm text-muted-foreground">{genResult}</p>
          )}

          {stats && (
            <div className="flex gap-4 mt-3 text-sm">
              <span className="text-muted-foreground">
                Match rule: <b className="text-foreground">{stats.matched}</b>
              </span>
              <span className="text-muted-foreground">
                Generated: <b className="text-green-600">{stats.generated}</b>
              </span>
              <span className="text-muted-foreground">
                Pending: <b className="text-amber-600">{stats.pending}</b>
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Creatives grid */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{totalCreatives} creatives</p>
        <Button variant="ghost" size="sm" onClick={() => { fetchCreatives(); fetchStats() }}>
          <RefreshCw className="h-3.5 w-3.5 mr-2" />
          Refresh
        </Button>
      </div>

      {loading && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="aspect-square rounded-lg bg-muted animate-pulse" />
          ))}
        </div>
      )}

      {!loading && creatives.length === 0 && (
        <div className="text-center py-20 text-muted-foreground border-2 border-dashed rounded-xl">
          <ImageIcon className="h-10 w-10 mx-auto mb-3 opacity-30" />
          <p className="font-medium">No creatives yet</p>
          <p className="text-sm mt-1">Set up rules, then click Generate to create creatives</p>
        </div>
      )}

      {!loading && creatives.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {creatives.map(creative => {
            const product = (creative as any).products
            const template = (creative as any).templates
            const originalImg = product?.product_images?.[0]?.src

            return (
              <Card key={creative.id} className="overflow-hidden group">
                <div className="aspect-square relative bg-muted overflow-hidden">
                  <img
                    src={creative.generated_url}
                    alt={product?.title}
                    className="w-full h-full object-cover"
                  />
                  {/* Hover overlay */}
                  <div className="absolute inset-0 bg-black/0 group-hover:bg-black/50 transition-all flex items-center justify-center gap-2 opacity-0 group-hover:opacity-100">
                    <a href={creative.generated_url} download target="_blank" rel="noopener noreferrer">
                      <Button size="icon" variant="secondary" className="h-8 w-8">
                        <Download className="h-3.5 w-3.5" />
                      </Button>
                    </a>
                    <Button
                      size="icon"
                      variant="destructive"
                      className="h-8 w-8"
                      onClick={() => handleDelete(creative.id, creative.cloudinary_public_id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                <CardContent className="p-2.5">
                  <p className="text-xs font-medium truncate">{product?.title}</p>
                  <div className="flex items-center justify-between mt-1">
                    <Badge variant="outline" className="text-xs py-0">{template?.name}</Badge>
                    <span className="text-xs text-muted-foreground">
                      {formatDistanceToNow(new Date(creative.updated_at), { addSuffix: true })}
                    </span>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      {totalCreatives > PER_PAGE && (
        <div className="flex items-center justify-center gap-3 pt-2">
          <Button variant="outline" size="sm" disabled={page === 0}
            onClick={() => setPage(p => Math.max(0, p - 1))}>
            Previous
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {page + 1} of {Math.ceil(totalCreatives / PER_PAGE)}
          </span>
          <Button variant="outline" size="sm"
            disabled={(page + 1) * PER_PAGE >= totalCreatives}
            onClick={() => setPage(p => p + 1)}>
            Next
          </Button>
        </div>
      )}
    </div>
  )
}