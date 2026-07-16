'use client'

import { useState, useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Wand2, Download, Trash2, RefreshCw, ImageIcon, Loader2, StopCircle } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { DownloadZipButton } from './download-zip-button'

interface Creative {
  id: string
  generated_url: string
  status: string
  updated_at: string
  template_id: string
  cloudinary_public_id: string
  products: { title: string; price: number; product_images: { src: string }[] }
  templates: { name: string }
}

interface BatchCounts {
  pending: number
  processing: number
  completed: number
  failed: number
  cancelled: number
  total: number
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
  const [stopping, setStopping] = useState(false)
  const [filterType, setFilterType] = useState('all')
  const [filterValue, setFilterValue] = useState('')
  const [genResult, setGenResult] = useState<string | null>(null)
  const [batchProgress, setBatchProgress] = useState<BatchCounts | null>(null)
  const [page, setPage] = useState(0)
  const [totalCreatives, setTotalCreatives] = useState(0)

  const currentBatchId = useRef<string | null>(null)
  const pollingActive = useRef(false)
  const lastCompletedAt = useRef<{ count: number; time: number }>({ count: 0, time: Date.now() })

  const PER_PAGE = 10

  useEffect(() => {
    if (selectedStore) setPage(0)
  }, [selectedStore])

  useEffect(() => {
    if (selectedStore) fetchCreatives()
  }, [selectedStore, page])

  async function fetchCreatives() {
    setLoading(true)
    const supabase = (await import('@/lib/supabase/client')).createClient()
    const fromRow = page * PER_PAGE
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
      .range(fromRow, fromRow + PER_PAGE - 1)
    setCreatives((data as any) || [])
    setTotalCreatives(count || 0)
    setLoading(false)
  }

  function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

  async function handleGenerate() {
    setGenerating(true)
    setStopping(false)
    setGenResult(null)
    setBatchProgress(null)
    currentBatchId.current = null
    pollingActive.current = true
    lastCompletedAt.current = { count: 0, time: Date.now() }

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
      pollingActive.current = false
      return
    }

    if (!data.enqueued) {
      setGenResult(data.message || 'No products matched the rules.')
      setGenerating(false)
      pollingActive.current = false
      return
    }

    const batchId: string = data.batchId
    currentBatchId.current = batchId
    setGenResult(`Queued ${data.enqueued} products — worker is processing…`)

    // Progress polling loop
    const tick = async (): Promise<void> => {
      if (!pollingActive.current) return
      try {
        const pr = await fetch(`/api/generate/enqueue?batchId=${batchId}`)
        const c: BatchCounts = await pr.json()
        setBatchProgress(c)

        const done = (c.completed || 0) + (c.failed || 0) + (c.cancelled || 0)

        // Update progress message
        if (c.completed > lastCompletedAt.current.count) {
          lastCompletedAt.current = { count: c.completed, time: Date.now() }
        }

        // Cancelled
        if (c.cancelled > 0 && (c.pending + c.processing) === 0) {
          setGenResult(`Stopped. ${c.completed} completed, ${c.cancelled} cancelled.`)
          fetchCreatives()
          setGenerating(false)
          pollingActive.current = false
          return
        }

        if (c.total > 0 && done >= c.total) {
          setGenResult(`Done. ${c.completed} created${c.failed ? `, ${c.failed} failed` : ''}.`)
          fetchCreatives()
          setGenerating(false)
          pollingActive.current = false
          return
        }

        setGenResult(`Generating… ${done}/${c.total} done`)
        fetchCreatives()
        setTimeout(tick, 2000)
      } catch {
        setTimeout(tick, 3000)
      }
    }
    tick()
  }

  async function handleStop() {
    if (!currentBatchId.current || !selectedStore) return
    setStopping(true)
    pollingActive.current = false
    try {
      const res = await fetch('/api/generate/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storeId: selectedStore, batchId: currentBatchId.current }),
      })
      const data = await res.json()
      setGenResult(res.ok
        ? `Stopped. ${data.cancelled} jobs cancelled.`
        : `Stop failed: ${data.error}`)
    } catch (err: any) {
      setGenResult(`Stop error: ${err.message}`)
    }
    setStopping(false)
    setGenerating(false)
    fetchCreatives()
  }

  async function handleDelete(creativeId: string, publicId: string) {
    if (!confirm('Delete this creative?')) return
    await fetch(`/api/creatives/${creativeId}`, { method: 'DELETE' })
    setCreatives(prev => prev.filter(c => c.id !== creativeId))
  }

  if (stores.length === 0) {
    return <p className="text-muted-foreground">No stores connected.</p>
  }

  const progressPercent = batchProgress && batchProgress.total > 0
    ? Math.round(((batchProgress.completed + batchProgress.failed + batchProgress.cancelled) / batchProgress.total) * 100)
    : 0

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="p-4 space-y-4">
          {/* Controls row */}
          <div className="flex flex-wrap items-center gap-3">
            {stores.length > 1 && (
              <Select value={selectedStore} onValueChange={setSelectedStore}>
                <SelectTrigger className="w-52"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {stores.map(s => (
                    <SelectItem key={s.id} value={s.id}>{s.shop_name || s.shop_domain}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            <Select value={filterType} onValueChange={v => { setFilterType(v); setFilterValue('') }}>
              <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
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

            {generating && (
              <Button
                variant="outline"
                onClick={handleStop}
                disabled={stopping}
                className="border-destructive text-destructive hover:bg-destructive hover:text-destructive-foreground"
              >
                {stopping
                  ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Stopping…</>
                  : <><StopCircle className="h-4 w-4 mr-2" />Stop</>
                }
              </Button>
            )}
          </div>

          {/* ── Progress bar — visible immediately when Generate is clicked ── */}
          {generating && (
            <div className="space-y-2">
              {/* Bar always visible; fills as jobs complete */}
              <div className="flex items-center gap-3">
                <Progress
                  value={batchProgress && batchProgress.total > 0 ? progressPercent : 0}
                  className="h-3 flex-1"
                />
                <span className="text-sm font-mono tabular-nums shrink-0 text-muted-foreground">
                  {batchProgress
                    ? `${batchProgress.completed + batchProgress.failed}/${batchProgress.total}`
                    : '0/…'}
                </span>
              </div>

              {/* Detailed counts — shown once the first poll returns */}
              {batchProgress && batchProgress.total > 0 ? (
                <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <span className="inline-block w-2 h-2 rounded-full bg-green-500" />
                    <b className="text-green-600">{batchProgress.completed}</b> done
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="inline-block w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                    <b className="text-blue-600">{batchProgress.processing}</b> processing
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="inline-block w-2 h-2 rounded-full bg-amber-400" />
                    <b className="text-amber-600">{batchProgress.pending}</b> pending
                  </span>
                  {batchProgress.failed > 0 && (
                    <span className="flex items-center gap-1">
                      <span className="inline-block w-2 h-2 rounded-full bg-red-500" />
                      <b className="text-destructive">{batchProgress.failed}</b> failed
                    </span>
                  )}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground animate-pulse">
                  Queuing jobs, worker starting…
                </p>
              )}
            </div>
          )}

          {/* Status message */}
          {genResult && (
            <p className="text-sm text-muted-foreground">{genResult}</p>
          )}
        </CardContent>
      </Card>

      {/* Creatives grid header */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{totalCreatives} creatives</p>
        <div className="flex items-center gap-2">
          {selectedStore && totalCreatives > 0 && (
            <DownloadZipButton storeId={selectedStore} />
          )}
          <Button variant="ghost" size="sm" onClick={fetchCreatives}>
            <RefreshCw className="h-3.5 w-3.5 mr-2" />Refresh
          </Button>
        </div>
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
            return (
              <Card key={creative.id} className="overflow-hidden group">
                <div className="aspect-square relative bg-muted overflow-hidden">
                  <img src={creative.generated_url} alt={product?.title} className="w-full h-full object-cover" />
                  <div className="absolute inset-0 bg-black/0 group-hover:bg-black/50 transition-all flex items-center justify-center gap-2 opacity-0 group-hover:opacity-100">
                    <a href={creative.generated_url} download target="_blank" rel="noopener noreferrer">
                      <Button size="icon" variant="secondary" className="h-8 w-8">
                        <Download className="h-3.5 w-3.5" />
                      </Button>
                    </a>
                    <Button size="icon" variant="destructive" className="h-8 w-8"
                      onClick={() => handleDelete(creative.id, creative.cloudinary_public_id)}>
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
            onClick={() => setPage(p => Math.max(0, p - 1))}>Previous</Button>
          <span className="text-sm text-muted-foreground">
            Page {page + 1} of {Math.ceil(totalCreatives / PER_PAGE)}
          </span>
          <Button variant="outline" size="sm"
            disabled={(page + 1) * PER_PAGE >= totalCreatives}
            onClick={() => setPage(p => p + 1)}>Next</Button>
        </div>
      )}
    </div>
  )
}