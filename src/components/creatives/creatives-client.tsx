'use client'

import { useState, useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Wand2, Download, Trash2, RefreshCw, ImageIcon, Loader2, StopCircle } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { DownloadZipButton } from './download-zip-button'
import { shopifyFetch } from '@/lib/shopify-token'

interface Creative {
  id: string
  url: string
  created_at: string
  template_id: string
  cloudinary_id: string | null
  variant_id: string | null
  products: { title: string } | null
  product_variants: { title: string | null; option1: string | null; option2: string | null; option3: string | null } | null
  templates: { name: string } | null
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

/** Shown as suggestions before the store's own option names have loaded (or
 *  for a store with none recorded yet — see /api/products/option-names). */
const DEFAULT_OPTION_NAME_SUGGESTIONS = ['Size', 'Colour', 'Material', 'Style']

/** "Red / M" from a variant's title, or its raw options if the title is unset. */
function variantLabel(v: Creative['product_variants']): string | null {
  if (!v) return null
  if (v.title && v.title !== 'Default Title') return v.title
  const opts = [v.option1, v.option2, v.option3].filter(Boolean)
  return opts.length ? opts.join(' / ') : null
}

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

  // ── Generate Scope ─────────────────────────────────────────────────────────
  const [variantScope, setVariantScope] = useState<'all' | 'specific'>('all')
  const [variantOptionName, setVariantOptionName] = useState('')
  const [variantOptionValue, setVariantOptionValue] = useState('')
  const [imageScope, setImageScope] = useState<'all' | 'first'>('all')
  const [optionNameSuggestions, setOptionNameSuggestions] = useState<string[]>([])

  const currentBatchId = useRef<string | null>(null)
  const pollingActive = useRef(false)
  const lastCompletedAt = useRef<{ count: number; time: number }>({ count: 0, time: Date.now() })

  const PER_PAGE = 10

  // Plain function, not useCallback: it's invoked imperatively from event
  // handlers (Refresh, post-delete, the generation-progress poll), which is
  // fine. The REACTIVE load below inlines the same query instead of calling
  // this, because `useEffect(() => { fetchCreatives() }, [fetchCreatives])`
  // trips the set-state-in-effect lint rule on the setState calls inside it —
  // the same reason rules-client.tsx's load effect is written this way.
  async function fetchCreatives() {
    if (!selectedStore) return
    setLoading(true)
    const supabase = (await import('@/lib/supabase/client')).createClient()
    const fromRow = page * PER_PAGE
    // generated_creatives (v2) carries store_id directly — a plain filter, no
    // join through products — and one row survives per (variant, image,
    // template) instead of the legacy table's one row per (product, template).
    const { data, count } = await supabase
      .from('generated_creatives')
      .select(`
        id, url, created_at, template_id, cloudinary_id, variant_id,
        products(title),
        product_variants(title, option1, option2, option3),
        templates(name)
      `, { count: 'exact' })
      .eq('store_id', selectedStore)
      .order('created_at', { ascending: false })
      .range(fromRow, fromRow + PER_PAGE - 1)
    setCreatives((data as any) || [])
    setTotalCreatives(count || 0)
    setLoading(false)
  }

  useEffect(() => {
    if (selectedStore) setPage(0)
  }, [selectedStore])

  // Reactive load on store/page change. Inlined + cancellation-guarded rather
  // than calling fetchCreatives(), so a slow response for a store the user has
  // since switched away from cannot overwrite the newer selection's data.
  useEffect(() => {
    if (!selectedStore) return
    let cancelled = false

    ;(async () => {
      setLoading(true)
      const supabase = (await import('@/lib/supabase/client')).createClient()
      const fromRow = page * PER_PAGE
      const { data, count } = await supabase
        .from('generated_creatives')
        .select(`
          id, url, created_at, template_id, cloudinary_id, variant_id,
          products(title),
          product_variants(title, option1, option2, option3),
          templates(name)
        `, { count: 'exact' })
        .eq('store_id', selectedStore)
        .order('created_at', { ascending: false })
        .range(fromRow, fromRow + PER_PAGE - 1)

      if (cancelled) return
      setCreatives((data as any) || [])
      setTotalCreatives(count || 0)
      setLoading(false)
    })()

    return () => { cancelled = true }
  }, [selectedStore, page])

  // Suggestions for the Option name field — best-effort; an empty/failed
  // response just leaves the four common defaults, never blocks the form.
  useEffect(() => {
    if (!selectedStore) return
    let cancelled = false
    shopifyFetch(`/api/products/option-names?storeId=${selectedStore}`)
      .then(res => res.json())
      .then(data => { if (!cancelled && Array.isArray(data.names)) setOptionNameSuggestions(data.names) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [selectedStore])

  function handleVariantScopeChange(v: string) {
    setVariantScope(v as 'all' | 'specific')
    setVariantOptionName('')
    setVariantOptionValue('')
  }

  async function handleGenerate() {
    setGenerating(true)
    setStopping(false)
    setGenResult(null)
    setBatchProgress(null)
    currentBatchId.current = null
    pollingActive.current = true
    lastCompletedAt.current = { count: 0, time: Date.now() }

    const res = await shopifyFetch('/api/generate/enqueue', {
      method: 'POST',
      body: JSON.stringify({
        storeId: selectedStore,
        filter: filterType === 'all' ? { type: 'all' } : { type: filterType, value: filterValue },
        variantScope,
        variantOption: variantScope === 'specific'
          ? { name: variantOptionName.trim(), value: variantOptionValue.trim() }
          : null,
        imageScope,
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
    setGenResult(`Queued ${data.enqueued} jobs — worker is processing…`)

    // Progress polling loop
    const tick = async (): Promise<void> => {
      if (!pollingActive.current) return
      try {
        const pr = await shopifyFetch(`/api/generate/enqueue?batchId=${batchId}`)
        const c: BatchCounts = await pr.json()
        setBatchProgress(c)

        const done = (c.completed || 0) + (c.failed || 0) + (c.cancelled || 0)

        if (c.completed > lastCompletedAt.current.count) {
          lastCompletedAt.current = { count: c.completed, time: Date.now() }
        }

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
      const res = await shopifyFetch('/api/generate/cancel', {
        method: 'POST',
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

  async function handleDelete(creativeId: string) {
    if (!confirm('Delete this creative?')) return
    await shopifyFetch(`/api/creatives/${creativeId}`, { method: 'DELETE' })
    setCreatives(prev => prev.filter(c => c.id !== creativeId))
  }

  if (stores.length === 0) {
    return <p className="text-muted-foreground">No stores connected.</p>
  }

  const progressPercent = batchProgress && batchProgress.total > 0
    ? Math.round(((batchProgress.completed + batchProgress.failed + batchProgress.cancelled) / batchProgress.total) * 100)
    : 0

  const generateDisabled =
    generating ||
    (variantScope === 'specific' && (!variantOptionName.trim() || !variantOptionValue.trim())) ||
    (filterType !== 'all' && !filterValue.trim())

  const scopeSummary = buildScopeSummary({
    variantScope, variantOptionName, variantOptionValue, imageScope, filterType, filterValue,
  })

  return (
    <div className="space-y-6">
      {/* ── Generate Scope ─────────────────────────────────────────────────── */}
      <Card>
        <CardContent className="p-4 space-y-3">
          {/* Row 1: Variants */}
          <div className="flex items-center gap-3">
            <span className="w-16 shrink-0 text-sm font-medium">Variants</span>
            <Select value={variantScope} onValueChange={handleVariantScopeChange}>
              <SelectTrigger className="flex-1 *:data-[slot=select-value]:min-w-0"><SelectValue /></SelectTrigger>
              <SelectContent>
                {/* Label and description sit in ONE row, not stacked: Radix
                    mirrors an item's children verbatim into the closed
                    trigger, so whatever layout is used here is also what the
                    collapsed dropdown shows — a stacked pair would centre two
                    lines in the trigger instead of reading as a single control. */}
                <SelectItem value="all">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="font-medium shrink-0">All variants</span>
                    <span className="truncate text-xs text-muted-foreground">
                      Every size, colour, and option for each product
                    </span>
                  </span>
                </SelectItem>
                <SelectItem value="specific">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="font-medium shrink-0">Specific option…</span>
                    <span className="truncate text-xs text-muted-foreground">
                      Choose one option value (e.g. Size: M) across all products
                    </span>
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Sub-row: option name + value — Option name is free text with
              suggestions, not a closed Select: there is no fixed list of
              option names across a whole store (a store can name it "Size",
              "Taille", or anything else), so a dropdown would either miss
              real values or need per-store data the merchant can't predict. */}
          {variantScope === 'specific' && (
            <div className="ml-[76px] space-y-1.5">
              <div className="flex items-center gap-2">
                <Input
                  list="option-name-suggestions"
                  className="w-40"
                  placeholder="Option name"
                  value={variantOptionName}
                  onChange={e => setVariantOptionName(e.target.value)}
                />
                <datalist id="option-name-suggestions">
                  {Array.from(new Set([...optionNameSuggestions, ...DEFAULT_OPTION_NAME_SUGGESTIONS])).map(n => (
                    <option key={n} value={n} />
                  ))}
                </datalist>
                <span className="text-sm text-muted-foreground">=</span>
                <Input
                  className="flex-1"
                  placeholder="e.g. M, Red, XL"
                  value={variantOptionValue}
                  onChange={e => setVariantOptionValue(e.target.value)}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Only generate for variants where{' '}
                <strong>{variantOptionName || 'option'}</strong> is{' '}
                <strong>{variantOptionValue || '…'}</strong>
              </p>
            </div>
          )}

          {/* Row 2: Images */}
          <div className="flex items-center gap-3">
            <span className="w-16 shrink-0 text-sm font-medium">Images</span>
            <Select value={imageScope} onValueChange={v => setImageScope(v as 'all' | 'first')}>
              <SelectTrigger className="flex-1 *:data-[slot=select-value]:min-w-0"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="font-medium shrink-0">All poses</span>
                    <span className="truncate text-xs text-muted-foreground">
                      Every image for each variant — angles, detail shots, lifestyle
                    </span>
                  </span>
                </SelectItem>
                <SelectItem value="first">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="font-medium shrink-0">First pose only</span>
                    <span className="truncate text-xs text-muted-foreground">
                      Only the primary / first image for each variant
                    </span>
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <p className="-mt-3 text-sm text-muted-foreground">
        Will generate: {scopeSummary}
      </p>

      {/* ── Controls + progress ───────────────────────────────────────────── */}
      <Card>
        <CardContent className="p-4 space-y-4">
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

            <Button onClick={handleGenerate} disabled={generateDisabled}>
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
        <EmptyState
          icon={ImageIcon}
          title="Generate your first creatives"
          description="Map products to a template in the Rules Engine, then generate — every matching variant gets its own creative."
          action={
            <Button size="lg" asChild>
              <a href="/dashboard/rules">Open Rules Engine</a>
            </Button>
          }
        />
      )}

      {!loading && creatives.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {creatives.map(creative => {
            const product = creative.products
            const template = creative.templates
            const vLabel = variantLabel(creative.product_variants)
            return (
              <Card key={creative.id} className="overflow-hidden group">
                <div className="aspect-square relative bg-muted overflow-hidden">
                  <img src={creative.url} alt={product?.title} className="w-full h-full object-cover" />
                  <div className="absolute inset-0 bg-black/0 group-hover:bg-black/50 transition-all flex items-center justify-center gap-2 opacity-0 group-hover:opacity-100">
                    <a href={creative.url} download target="_blank" rel="noopener noreferrer">
                      <Button size="icon" variant="secondary" className="h-8 w-8">
                        <Download className="h-3.5 w-3.5" />
                      </Button>
                    </a>
                    <Button size="icon" variant="destructive" className="h-8 w-8"
                      onClick={() => handleDelete(creative.id)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                <CardContent className="p-2.5">
                  <p className="text-xs font-medium truncate">{product?.title}</p>
                  {vLabel && (
                    <p className="text-[11px] text-muted-foreground truncate">{vLabel}</p>
                  )}
                  <div className="flex items-center justify-between mt-1">
                    <Badge variant="outline" className="text-xs py-0">{template?.name}</Badge>
                    <span className="text-xs text-muted-foreground">
                      {formatDistanceToNow(new Date(creative.created_at), { addSuffix: true })}
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

function buildScopeSummary({
  variantScope, variantOptionName, variantOptionValue, imageScope, filterType, filterValue,
}: {
  variantScope: 'all' | 'specific'
  variantOptionName: string
  variantOptionValue: string
  imageScope: 'all' | 'first'
  filterType: string
  filterValue: string
}): string {
  const vPart = variantScope === 'all'
    ? 'all variants'
    : `${variantOptionName || 'option'} ${variantOptionValue || '…'} variants`

  const iPart = imageScope === 'all' ? 'all poses' : 'first pose only'

  const pPart = filterType === 'all'
    ? 'all products'
    : filterValue
      ? `products ${filterType === 'tag' ? 'tagged' : `(${filterType})`} "${filterValue}"`
      : 'all products'

  return `${vPart} · ${iPart} · ${pPart}`
}
