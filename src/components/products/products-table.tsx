'use client'

import { useRouter } from 'next/navigation'
import { Badge } from '@/components/ui/badge'
import { formatDistanceToNow } from 'date-fns'
import { cn } from '@/lib/utils'

export interface ProductVariantLite {
  id: string
  price: number | null
  compare_at_price: number | null
  inventory_quantity: number | null
  is_sold_out: boolean | null
}

interface Product {
  id: string
  title: string
  vendor: string | null
  product_type: string | null
  tags: string[]
  status: string
  updated_at: string
  product_images: { src: string; is_primary: boolean }[]
  product_variants: ProductVariantLite[]
}

/** Below this, a variant is "low stock" rather than plainly in stock. */
const LOW_STOCK_THRESHOLD = 5

function formatPrice(price: number) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', maximumFractionDigits: 0,
  }).format(price)
}

/**
 * Roll a product's variants up into one stock verdict.
 *
 * Worst-case wins: if every variant is sold out the product is Sold Out, but a
 * single in-stock variant still makes the product buyable — which is exactly
 * how Shopify's storefront behaves, so the badge must not claim otherwise.
 */
function stockSummary(variants: ProductVariantLite[]) {
  if (variants.length === 0) return { label: 'No variants', tone: 'muted' as const, total: 0 }

  const total = variants.reduce((sum, v) => sum + (v.inventory_quantity ?? 0), 0)
  const allSoldOut = variants.every(v => v.is_sold_out)

  if (allSoldOut) return { label: 'Sold Out', tone: 'red' as const, total }
  if (total < LOW_STOCK_THRESHOLD) return { label: 'Low Stock', tone: 'amber' as const, total }
  return { label: 'In Stock', tone: 'green' as const, total }
}

/** Price range across variants — "₹1,200 – ₹1,800" when they differ. */
function priceSummary(variants: ProductVariantLite[]) {
  const prices = variants.map(v => Number(v.price ?? 0)).filter(p => p > 0)
  if (prices.length === 0) return { label: '—', compareAt: null as number | null, discount: null as number | null }

  const min = Math.min(...prices)
  const max = Math.max(...prices)
  const label = min === max ? formatPrice(min) : `${formatPrice(min)} – ${formatPrice(max)}`

  // Discount is quoted off the cheapest variant, which is the one the range leads with.
  const cheapest = variants.find(v => Number(v.price ?? 0) === min)
  const compareAt = cheapest?.compare_at_price == null ? null : Number(cheapest.compare_at_price)
  const discount = compareAt && compareAt > min
    ? Math.round(((compareAt - min) / compareAt) * 100)
    : null

  return { label, compareAt, discount }
}

const TONE_CLASS = {
  green: 'bg-green-100 text-green-800 dark:bg-green-950/40 dark:text-green-400',
  amber: 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-400',
  red:   'bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-400',
  muted: 'bg-muted text-muted-foreground',
} as const

export function ProductsTable({ products }: { products: Product[] }) {
  const router = useRouter()

  return (
    <div className="border rounded-lg overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/50">
            <th className="text-left p-3 font-medium text-muted-foreground">Product</th>
            <th className="text-left p-3 font-medium text-muted-foreground">Variants</th>
            <th className="text-left p-3 font-medium text-muted-foreground">Inventory</th>
            <th className="text-left p-3 font-medium text-muted-foreground">Vendor</th>
            <th className="text-left p-3 font-medium text-muted-foreground">Price</th>
            <th className="text-left p-3 font-medium text-muted-foreground">Tags</th>
            <th className="text-left p-3 font-medium text-muted-foreground">Updated</th>
          </tr>
        </thead>
        <tbody>
          {products.map(product => {
            const variants = product.product_variants ?? []
            const imageUrl = product.product_images?.[0]?.src
            const stock = stockSummary(variants)
            const price = priceSummary(variants)

            return (
              <tr
                key={product.id}
                className="border-b hover:bg-muted/30 transition-colors cursor-pointer"
                onClick={() => router.push(`/dashboard/products/${product.id}`)}
              >
                <td className="p-3">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-md bg-muted overflow-hidden flex-shrink-0">
                      {imageUrl && (
                        <img src={imageUrl} alt={product.title} className="w-full h-full object-cover" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <p className="font-medium line-clamp-1">{product.title}</p>
                      {product.status !== 'active' && (
                        <Badge variant="outline" className="mt-0.5 text-[10px] py-0 capitalize">
                          {product.status}
                        </Badge>
                      )}
                    </div>
                  </div>
                </td>

                <td className="p-3 text-muted-foreground tabular-nums">
                  {variants.length}
                </td>

                <td className="p-3">
                  <span className={cn(
                    'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                    TONE_CLASS[stock.tone]
                  )}>
                    {stock.label}
                  </span>
                  {variants.length > 0 && (
                    <p className="mt-0.5 text-[11px] text-muted-foreground tabular-nums">
                      {stock.total} in stock
                    </p>
                  )}
                </td>

                <td className="p-3 text-muted-foreground">{product.vendor || '—'}</td>

                <td className="p-3">
                  <div className="flex items-center gap-2">
                    <span className="font-medium whitespace-nowrap">{price.label}</span>
                    {price.discount && (
                      <Badge variant="destructive" className="text-xs py-0">-{price.discount}%</Badge>
                    )}
                  </div>
                  {price.compareAt && price.discount && (
                    <p className="text-xs text-muted-foreground line-through">
                      {formatPrice(price.compareAt)}
                    </p>
                  )}
                </td>

                <td className="p-3">
                  <div className="flex flex-wrap gap-1 max-w-[180px]">
                    {product.tags?.slice(0, 3).map(tag => (
                      <Badge key={tag} variant="outline" className="text-xs py-0">{tag}</Badge>
                    ))}
                    {product.tags && product.tags.length > 3 && (
                      <Badge variant="outline" className="text-xs py-0">+{product.tags.length - 3}</Badge>
                    )}
                  </div>
                </td>

                <td className="p-3 text-muted-foreground text-xs whitespace-nowrap">
                  {formatDistanceToNow(new Date(product.updated_at), { addSuffix: true })}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      {products.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          No products found
        </div>
      )}
    </div>
  )
}
