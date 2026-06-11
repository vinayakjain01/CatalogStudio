'use client'

import { useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import Image from 'next/image'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Search } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'

interface Product {
  id: string
  title: string
  vendor: string | null
  product_type: string | null
  tags: string[]
  price: number
  compare_at_price: number | null
  inventory_quantity: number
  status: string
  updated_at: string
  product_images: { src: string; is_primary: boolean }[]
}

export function ProductsTable({ products }: { products: Product[] }) {
  const [search, setSearch] = useState('')
  const router = useRouter()
  const pathname = usePathname()

  const filtered = products.filter(p =>
    p.title.toLowerCase().includes(search.toLowerCase()) ||
    (p.vendor || '').toLowerCase().includes(search.toLowerCase())
  )

  function formatPrice(price: number) {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(price)
  }

  function getDiscount(price: number, compareAt: number | null) {
    if (!compareAt || compareAt <= price) return null
    return Math.round(((compareAt - price) / compareAt) * 100)
  }

  return (
    <div className="space-y-4">
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search products…"
          className="pl-9"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      <div className="border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="text-left p-3 font-medium text-muted-foreground">Product</th>
              <th className="text-left p-3 font-medium text-muted-foreground">Vendor</th>
              <th className="text-left p-3 font-medium text-muted-foreground">Type</th>
              <th className="text-left p-3 font-medium text-muted-foreground">Price</th>
              <th className="text-left p-3 font-medium text-muted-foreground">Tags</th>
              <th className="text-left p-3 font-medium text-muted-foreground">Updated</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(product => {
              const imageUrl = product.product_images?.[0]?.src
              const discount = getDiscount(product.price, product.compare_at_price)

              return (
                <tr key={product.id} className="border-b hover:bg-muted/30 transition-colors">
                  <td className="p-3">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-md bg-muted overflow-hidden flex-shrink-0">
                        {imageUrl && (
                          <img src={imageUrl} alt={product.title} className="w-full h-full object-cover" />
                        )}
                      </div>
                      <div>
                        <p className="font-medium line-clamp-1">{product.title}</p>
                        <p className="text-xs text-muted-foreground">
                          Stock: {product.inventory_quantity}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="p-3 text-muted-foreground">{product.vendor || '—'}</td>
                  <td className="p-3 text-muted-foreground">{product.product_type || '—'}</td>
                  <td className="p-3">
                    <div>
                      <span className="font-medium">{formatPrice(product.price)}</span>
                      {discount && (
                        <Badge variant="destructive" className="ml-2 text-xs py-0">
                          -{discount}%
                        </Badge>
                      )}
                    </div>
                    {product.compare_at_price && (
                      <p className="text-xs text-muted-foreground line-through">
                        {formatPrice(product.compare_at_price)}
                      </p>
                    )}
                  </td>
                  <td className="p-3">
                    <div className="flex flex-wrap gap-1 max-w-[180px]">
                      {product.tags.slice(0, 3).map(tag => (
                        <Badge key={tag} variant="outline" className="text-xs py-0">
                          {tag}
                        </Badge>
                      ))}
                      {product.tags.length > 3 && (
                        <Badge variant="outline" className="text-xs py-0">
                          +{product.tags.length - 3}
                        </Badge>
                      )}
                    </div>
                  </td>
                  <td className="p-3 text-muted-foreground text-xs">
                    {formatDistanceToNow(new Date(product.updated_at), { addSuffix: true })}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>

        {filtered.length === 0 && (
          <div className="text-center py-12 text-muted-foreground">
            No products found
          </div>
        )}
      </div>
    </div>
  )
}