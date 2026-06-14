'use client'

import { useState } from 'react'
import { useBuilderStore, PreviewProduct } from '@/stores/builder-store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Eye, EyeOff, Search } from 'lucide-react'

interface Product {
  id: string
  title: string
  price: number
  compare_at_price: number | null
  vendor: string | null
  product_type: string | null
  product_images: { src: string; is_primary: boolean }[]
}

interface Props {
  products: Product[]
}

export function ProductPreviewSelector({ products }: Props) {
  const { previewProduct, setPreviewProduct } = useBuilderStore()
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState(false)

  const filtered = products.filter(p =>
    p.title.toLowerCase().includes(search.toLowerCase())
  )

  function selectProduct(p: Product) {
    const primaryImage = p.product_images?.find(i => i.is_primary) || p.product_images?.[0]
    const preview: PreviewProduct = {
      title: p.title,
      price: p.price,
      compare_at_price: p.compare_at_price,
      vendor: p.vendor,
      product_type: p.product_type,
      imageUrl: primaryImage?.src || null,
    }
    setPreviewProduct(preview)
    setOpen(false)
  }

  function clearPreview() {
    setPreviewProduct(null)
  }

  return (
    <div className="relative">
      <div className="flex items-center gap-1.5 px-3 py-2 border-b">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs gap-1.5 flex-1 justify-start text-muted-foreground"
          onClick={() => setOpen(!open)}
        >
          <Eye className="h-3.5 w-3.5" />
          {previewProduct ? (
            <span className="truncate max-w-[120px]">{previewProduct.title}</span>
          ) : (
            'Preview with product'
          )}
        </Button>
        {previewProduct && (
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={clearPreview}>
            <EyeOff className="h-3 w-3" />
          </Button>
        )}
      </div>

      {open && (
        <div className="absolute left-0 right-0 top-full z-50 bg-card border-b border-x rounded-b-lg shadow-lg max-h-64 overflow-hidden flex flex-col">
          <div className="p-2 border-b">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search products…"
                className="h-7 pl-7 text-xs"
                autoFocus
              />
            </div>
          </div>
          <div className="overflow-y-auto flex-1">
            {filtered.length === 0 && (
              <p className="text-xs text-muted-foreground text-center py-4">No products found</p>
            )}
            {filtered.slice(0, 50).map(p => {
              const img = p.product_images?.find(i => i.is_primary) || p.product_images?.[0]
              return (
                <button
                  key={p.id}
                  className="w-full flex items-center gap-2 px-3 py-2 hover:bg-muted text-left transition-colors"
                  onClick={() => selectProduct(p)}
                >
                  <div className="w-8 h-8 rounded bg-muted overflow-hidden flex-shrink-0">
                    {img && <img src={img.src} alt="" className="w-full h-full object-cover" />}
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs font-medium truncate">{p.title}</p>
                    <p className="text-xs text-muted-foreground">
                      ₹{Number(p.price).toLocaleString('en-IN')}
                    </p>
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}