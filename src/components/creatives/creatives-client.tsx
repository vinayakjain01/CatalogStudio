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

  useEffect(() => {
    if (selectedStore) fetchCreatives()
  }, [selectedStore])

  async function fetchCreatives() {
    setLoading(true)
    const supabase = (await import('@/lib/supabase/client')).createClient()

    const { data } = await supabase
      .from('generated_images')
      .select(`
        id, generated_url, status, updated_at, template_id, cloudinary_public_id,
        products!inner(title, price, store_id, product_images(src, is_primary)),
        templates(name)
      `)
      .eq('products.store_id', selectedStore)
      .eq('status', 'completed')
      .order('updated_at', { ascending: false })
      .limit(100)

    setCreatives((data as any) || [])
    setLoading(false)
  }

  async function handleGenerate() {
    setGenerating(true)
    setGenResult(null)

    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        storeId: selectedStore,
        filter: filterType === 'all' ? { type: 'all' } : { type: filterType, value: filterValue },
      }),
    })

    const data = await res.json()
    if (res.ok) {
      setGenResult(`Generated ${data.generated} creatives from ${data.total} products`)
      fetchCreatives()
    } else {
      setGenResult(data.error || 'Generation failed')
    }
    setGenerating(false)
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
        </CardContent>
      </Card>

      {/* Creatives grid */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{creatives.length} creatives</p>
        <Button variant="ghost" size="sm" onClick={fetchCreatives}>
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
    </div>
  )
}
