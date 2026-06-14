'use client'

import { useEffect, useState } from 'react'
import { useBuilderStore } from '@/stores/builder-store'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface PreviewProduct {
  id: string
  title: string
  price: number
  compare_at_price: number | null
  vendor: string | null
  product_type: string | null
  imageUrl: string | null
}

// Lets the user flip through real products while editing a template — the
// canvas re-renders instantly with each product's real image/title/price.
// Seeded server-side, then lazily fetches the fuller list on first open.
export function ProductPreviewSelector({
  storeId,
  initialProducts,
}: {
  storeId?: string
  initialProducts: PreviewProduct[]
}) {
  const { setPreviewProduct } = useBuilderStore()
  const [products, setProducts] = useState<PreviewProduct[]>(initialProducts)
  const [selectedId, setSelectedId] = useState<string | null>(initialProducts[0]?.id ?? null)
  const [loaded, setLoaded] = useState(false)

  // Push the initial selection into the store on mount.
  useEffect(() => {
    if (initialProducts[0]) setPreviewProduct(stripId(initialProducts[0]))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function loadFullList() {
    if (loaded || !storeId) return
    try {
      const res = await fetch(`/api/products?storeId=${storeId}&limit=100`)
      const data = await res.json()
      if (data.products?.length) setProducts(data.products)
    } catch {}
    setLoaded(true)
  }

  function select(id: string) {
    const p = products.find(x => x.id === id)
    if (!p) return
    setSelectedId(id)
    setPreviewProduct(stripId(p))
  }

  function step(dir: 1 | -1) {
    if (!selectedId) return
    const idx = products.findIndex(p => p.id === selectedId)
    const next = products[(idx + dir + products.length) % products.length]
    if (next) select(next.id)
  }

  if (products.length === 0) {
    return <span className="text-xs text-muted-foreground">No products to preview</span>
  }

  return (
    <div className="flex items-center gap-1">
      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => step(-1)}
        disabled={products.length < 2} title="Previous product">
        <ChevronLeft className="h-4 w-4" />
      </Button>

      <Select
        value={selectedId ?? undefined}
        onValueChange={select}
        onOpenChange={(open) => { if (open) loadFullList() }}
      >
        <SelectTrigger className="h-7 w-52 text-xs">
          <SelectValue placeholder="Preview product…" />
        </SelectTrigger>
        <SelectContent>
          {products.map(p => (
            <SelectItem key={p.id} value={p.id} className="text-xs">
              {p.title}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => step(1)}
        disabled={products.length < 2} title="Next product">
        <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  )
}

// store expects PreviewProduct without id
function stripId(p: PreviewProduct) {
  const { id, ...rest } = p
  return rest
}