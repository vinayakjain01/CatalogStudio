'use client'

/**
 * Variant selector + per-variant detail for the product page.
 *
 * v2 addresses everything per variant, so this is where a merchant picks which
 * one they are looking at: its own images, its own price and stock, and the
 * creative generated for it.
 *
 * The picker is a dropdown, not a row of pills. A real product here has 80
 * variants (5 sizes x 4 heights x 2 colours); as pills they filled the screen
 * and pushed the actual product content entirely below the fold.
 */
import { useMemo, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Download, ImageIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { StatusBadge } from '@/components/ui/status-badge'
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
  image_id?: string | null
  created_at: string
  templates?: { name: string } | null
}

const LOW_STOCK_THRESHOLD = 5

/** Store currency, not a hardcoded one — see products-table. */
function formatPrice(value: number | null, currency: string) {
  if (value == null) return '—'
  return new Intl.NumberFormat(undefined, {
    style: 'currency', currency, maximumFractionDigits: 0,
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
  currency = 'USD',
}: {
  productId: string
  storeId: string
  variants: VariantRow[]
  images: ImageRow[]
  creatives: CreativeRow[]
  currency?: string
}) {
  const [selectedId, setSelectedId] = useState(variants[0]?.id ?? '')
  const selected = variants.find(v => v.id === selectedId) ?? variants[0]

  // Images Shopify associated with this variant; fall back to all product
  // images, because most catalogs never assign images per variant.
  const shownImages = useMemo(() => {
    if (!selected) return images
    const forVariant = images.filter(img =>
      (img.variant_ids ?? []).includes(selected.shopify_variant_id)
    )
    return forVariant.length > 0 ? forVariant : images
  }, [images, selected])

  const [activeImageId, setActiveImageId] = useState<string | null>(null)

  // Resolved during render rather than reset in an effect: if the stored id is
  // not in the current set (the variant changed), this falls back to the first
  // image on its own. An effect would re-render twice and trips the compiler's
  // set-state-in-effect rule for no benefit.
  const activeImage =
    shownImages.find(img => img.id === activeImageId) ?? shownImages[0] ?? null

  // Every creative generated for this exact variant — "All poses" fans out
  // one job (and so one creative) per image, and a merchant needs to see
  // every one of them, not just whichever happened to sort first. Falls back
  // to product-level creatives (variant_id null — the pre-v2/no-variant path)
  // only when this variant has none of its own.
  const variantCreatives = useMemo(() => {
    if (!selected) return []
    const own = creatives.filter(c => c.variant_id === selected.id)
    const pool = own.length > 0 ? own : creatives.filter(c => c.variant_id == null)
    return pool.sort((a, b) => {
      // Order to match the "Original" pose strip so the two line up visually.
      const posA = shownImages.findIndex(img => img.id === a.image_id)
      const posB = shownImages.findIndex(img => img.id === b.image_id)
      if (posA !== -1 && posB !== -1) return posA - posB
      if (posA !== -1) return -1
      if (posB !== -1) return 1
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    })
  }, [creatives, selected, shownImages])

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

  const price = Number(selected.price ?? 0)
  const compareAt = selected.compare_at_price == null ? null : Number(selected.compare_at_price)
  const onSale = compareAt !== null && compareAt > price
  const discount = onSale ? Math.round(((compareAt - price) / compareAt) * 100) : null
  const qty = selected.inventory_quantity ?? 0

  const inStock = variants.filter(v => !v.is_sold_out)
  const soldOut = variants.filter(v => v.is_sold_out)

  return (
    <div className="space-y-5">
      {/* ── Variant picker ─────────────────────────────────────────────── */}
      {variants.length > 1 && (
        <div className="max-w-md">
          <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
            Variant ({variants.length})
          </label>
          <Select value={selected.id} onValueChange={setSelectedId}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            {/* Grouped so buyable variants surface first: with 80 options,
                scrolling past sold-out ones to find stock is the common task. */}
            <SelectContent className="max-h-80">
              {inStock.length > 0 && (
                <SelectGroup>
                  <SelectLabel>Available ({inStock.length})</SelectLabel>
                  {inStock.map(v => (
                    <SelectItem key={v.id} value={v.id}>{variantLabel(v)}</SelectItem>
                  ))}
                </SelectGroup>
              )}
              {soldOut.length > 0 && (
                <SelectGroup>
                  <SelectLabel>Sold out ({soldOut.length})</SelectLabel>
                  {soldOut.map(v => (
                    <SelectItem key={v.id} value={v.id}>{variantLabel(v)}</SelectItem>
                  ))}
                </SelectGroup>
              )}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* ── Selected variant facts ─────────────────────────────────────── */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-x-8 gap-y-3 p-4 text-sm">
          <Fact label="Price">
            <span className="font-semibold">{formatPrice(price, currency)}</span>
            {onSale && (
              <>
                <span className="ml-2 text-muted-foreground line-through">
                  {formatPrice(compareAt, currency)}
                </span>
                <StatusBadge tone="sale" className="ml-2">-{discount}%</StatusBadge>
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

      {/* ── Original vs generated ──────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <div>
          <div className="mb-2 flex min-h-8 items-center justify-between gap-2">
            <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
              Original
            </h2>
            {shownImages.length > 1 && (
              <span className="text-xs text-muted-foreground tabular-nums">
                {shownImages.findIndex(i => i.id === activeImage?.id) + 1} / {shownImages.length}
              </span>
            )}
          </div>

          <Card className="overflow-hidden">
            <div className="aspect-square bg-muted">
              {activeImage ? (
                <img
                  src={activeImage.cloudinary_url || activeImage.src}
                  alt={activeImage.alt || variantLabel(selected)}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                  <ImageIcon className="h-8 w-8 opacity-30" />
                </div>
              )}
            </div>
          </Card>

          {/* Thumbnails now SELECT the main image. Previously they only
              displayed it, so images 2-5 were visible but unreachable. */}
          {shownImages.length > 1 && (
            <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
              {shownImages.map((img, i) => {
                const isActive = img.id === activeImage?.id
                return (
                  <button
                    key={img.id}
                    type="button"
                    onClick={() => setActiveImageId(img.id)}
                    aria-label={`View image ${i + 1} of ${shownImages.length}`}
                    aria-current={isActive}
                    className={cn(
                      'h-16 w-16 flex-shrink-0 overflow-hidden rounded-md border-2 bg-muted transition-all',
                      isActive
                        ? 'border-primary ring-2 ring-primary/20'
                        : 'border-transparent opacity-70 hover:opacity-100'
                    )}
                  >
                    <img
                      src={img.cloudinary_url || img.src}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  </button>
                )
              })}
            </div>
          )}
        </div>

        <div>
          <div className="mb-2 flex min-h-8 items-center justify-between gap-2">
            <h2 className="truncate text-sm font-medium uppercase tracking-wide text-muted-foreground">
              Generated creatives
            </h2>
            <div className="flex items-center gap-2">
              {variantCreatives.length > 1 && (
                <span className="text-xs text-muted-foreground tabular-nums">
                  {variantCreatives.length}
                </span>
              )}
              <ProductGenerateButton
                productId={productId}
                storeId={storeId}
                variantId={selected.id}
                imageId={activeImage?.id ?? null}
              />
            </div>
          </div>

          {variantCreatives.length > 0 ? (
            /* Horizontal strip, not a single image: "All poses" fans out one
               creative per image, so a variant can have several — showing
               only the first silently hid the rest of what was generated. */
            <div className="flex gap-3 overflow-x-auto pb-1">
              {variantCreatives.map(c => {
                const poseIndex = shownImages.findIndex(img => img.id === c.image_id)
                return (
                  <Card key={c.id} className="w-40 flex-shrink-0 overflow-hidden">
                    <div className="group relative aspect-square bg-muted">
                      <img src={c.url} alt="Generated" className="h-full w-full object-cover" />
                      <div className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-all group-hover:bg-black/40 group-hover:opacity-100">
                        <a href={c.url} download target="_blank" rel="noopener noreferrer">
                          <Button size="icon" variant="secondary" className="h-8 w-8">
                            <Download className="h-3.5 w-3.5" />
                          </Button>
                        </a>
                      </div>
                    </div>
                    <div className="px-2 py-1.5">
                      <p className="truncate text-[11px] text-muted-foreground">
                        {poseIndex >= 0 ? `Pose ${poseIndex + 1}` : c.templates?.name || 'Creative'}
                      </p>
                    </div>
                  </Card>
                )
              })}
            </div>
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
  if (soldOut) return <StatusBadge tone="sold_out">Sold Out</StatusBadge>
  if (qty < LOW_STOCK_THRESHOLD) return <StatusBadge tone="low_stock">Low Stock · {qty}</StatusBadge>
  return <StatusBadge tone="in_stock">In Stock · {qty}</StatusBadge>
}
