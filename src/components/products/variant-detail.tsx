'use client'

/**
 * Variant selector + per-variant detail for the product page.
 *
 * v2 addresses everything per variant, so this is where a merchant picks which
 * one they are looking at: its own images, its own price and stock, and the
 * creative generated for it. Previously the page showed only the flattened
 * variant[0] values and there was no way to reach the others at all.
 */
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Download, ImageIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ProductGenerateButton } from '@/components/products/product-generate-button'

export interface VariantRow {
  id: string
  shopify_variant_id: string
  title: string | null
  sku: string | null
  barcode: string | null
  price: number | null
  compare_at_price: number | null
  inventory_quantity: number | null
  is_sold_out: boolean | null
  option1: string | null
  option2: string | null
  option3: string | null
  position: number | null
}

export interface ImageRow {
  id: string
  src: string
  cloudinary_url: string | null
  alt: string | null
  position: number | null
  is_primary: boolean | null
  variant_ids: string[] | null
}

export interface CreativeRow {
  id: string
  url: string
  variant_id: string | null
  created_at: string
  templates?: { name: string } | null
}

const LOW_STOCK_THRESHOLD = 5

function formatPrice(value: number | null) {
  if (value == null) return '—'
  return new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', maximumFractionDigits: 0,
  }).format(value)
}

function variantLabel(v: VariantRow) {
  if (v.title && v.title !== 'Default Title') return v.title
  const opts = [v.option1, v.option2, v.option3].filter(Boolean)
  return opts.length ? opts.join(' / ') : 'Default'
}

export function VariantDetail({
  productId,
  storeId,
  variants,
  images,
  creatives,
}: {
  productId: string
  storeId: string
  variants: VariantRow[]
  images: ImageRow[]
  creatives: CreativeRow[]
}) {
  const [selectedId, setSelectedId] = useState(variants[0]?.id ?? '')
  const selected = variants.find(v => v.id === selectedId) ?? variants[0]

  if (!selected) {
    return (
      <Card className="border-dashed">
        <CardContent className="py-12 text-center text-muted-foreground">
          <p className="text-sm">No variants synced for this product.</p>
          <p className="mt-1 text-xs">Re-sync the store from Settings.</p>
        </CardContent>
      </Card>
    )
  }

  // Images Shopify associated with this variant; fall back to all product
  // images, because most catalogs never assign images per variant.
  const variantImages = images.filter(img =>
    (img.variant_ids ?? []).includes(selected.shopify_variant_id)
  )
  const shownImages = variantImages.length > 0 ? variantImages : images

  // Creative for this exact variant wins over a product-level one.
  const variantCreatives = creatives
    .filter(c => c.variant_id === selected.id || c.variant_id == null)
    .sort((a, b) => {
      const exact = Number(b.variant_id === selected.id) - Number(a.variant_id === selected.id)
      if (exact !== 0) return exact
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    })
  const creative = variantCreatives[0] ?? null

  const price = Number(selected.price ?? 0)
  const compareAt = selected.compare_at_price == null ? null : Number(selected.compare_at_price)
  const onSale = compareAt !== null && compareAt > price
  const discount = onSale ? Math.round(((compareAt - price) / compareAt) * 100) : null
  const qty = selected.inventory_quantity ?? 0

  return (
    <div className="space-y-5">
      {/* Variant picker */}
      {variants.length > 1 && (
        <div>
          <p className="mb-2 text-xs font-medium text-muted-foreground">
            VARIANTS ({variants.length})
          </p>
          <div className="flex flex-wrap gap-2">
            {variants.map(v => (
              <button
                key={v.id}
                onClick={() => setSelectedId(v.id)}
                className={cn(
                  'rounded-lg border px-3 py-1.5 text-sm transition-colors',
                  v.id === selected.id
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'hover:bg-muted',
                  v.is_sold_out && v.id !== selected.id && 'opacity-60'
                )}
              >
                {variantLabel(v)}
                {v.is_sold_out && (
                  <span className="ml-1.5 text-[10px] uppercase opacity-80">sold out</span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Selected variant facts */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-3 p-4 text-sm">
          <Fact label="Price">
            <span className="font-semibold">{formatPrice(price)}</span>
            {onSale && (
              <>
                <span className="ml-2 text-muted-foreground line-through">{formatPrice(compareAt)}</span>
                <Badge variant="destructive" className="ml-2 py-0 text-xs">-{discount}%</Badge>
              </>
            )}
          </Fact>

          <Fact label="Availability">
            <StockBadge soldOut={Boolean(selected.is_sold_out)} qty={qty} />
          </Fact>

          <Fact label="SKU">{selected.sku || '—'}</Fact>
          <Fact label="Barcode">{selected.barcode || '—'}</Fact>
        </CardContent>
      </Card>

      {/* Original vs generated, aligned */}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <div>
          <div className="mb-2 flex min-h-8 items-center">
            <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
              Original
            </h2>
          </div>
          <Card className="overflow-hidden">
            <div className="aspect-square bg-muted">
              {shownImages[0] ? (
                <img
                  src={shownImages[0].cloudinary_url || shownImages[0].src}
                  alt={variantLabel(selected)}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                  <ImageIcon className="h-8 w-8 opacity-30" />
                </div>
              )}
            </div>
          </Card>
          {shownImages.length > 1 && (
            <div className="mt-2 flex gap-2 overflow-x-auto">
              {shownImages.map(img => (
                <div key={img.id} className="h-16 w-16 flex-shrink-0 overflow-hidden rounded-md border bg-muted">
                  <img src={img.cloudinary_url || img.src} alt="" className="h-full w-full object-cover" />
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <div className="mb-2 flex min-h-8 items-center justify-between gap-2">
            <h2 className="truncate text-sm font-medium uppercase tracking-wide text-muted-foreground">
              Generated creative
            </h2>
            <ProductGenerateButton productId={productId} storeId={storeId} />
          </div>

          {creative ? (
            <>
              <Card className="overflow-hidden">
                <div className="group relative aspect-square bg-muted">
                  <img src={creative.url} alt="Generated" className="h-full w-full object-cover" />
                  <div className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-all group-hover:bg-black/40 group-hover:opacity-100">
                    <a href={creative.url} download target="_blank" rel="noopener noreferrer">
                      <Button size="sm" variant="secondary">
                        <Download className="h-3.5 w-3.5" />
                        Download
                      </Button>
                    </a>
                  </div>
                </div>
              </Card>
              {creative.templates?.name && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Template: {creative.templates.name}
                </p>
              )}
            </>
          ) : (
            <Card className="border-dashed">
              <CardContent className="flex aspect-square flex-col items-center justify-center text-muted-foreground">
                <ImageIcon className="mb-2 h-8 w-8 opacity-30" />
                <p className="text-sm">No creative for this variant</p>
                <p className="mt-1 text-xs">Generate one based on your rules</p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="mt-0.5">{children}</div>
    </div>
  )
}

function StockBadge({ soldOut, qty }: { soldOut: boolean; qty: number }) {
  if (soldOut) {
    return (
      <span className="inline-flex rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800 dark:bg-red-950/40 dark:text-red-400">
        Sold Out
      </span>
    )
  }
  if (qty < LOW_STOCK_THRESHOLD) {
    return (
      <span className="inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950/40 dark:text-amber-400">
        Low Stock · {qty}
      </span>
    )
  }
  return (
    <span className="inline-flex rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800 dark:bg-green-950/40 dark:text-green-400">
      In Stock · {qty}
    </span>
  )
}
