import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { ArrowLeft, ImageIcon, Download } from 'lucide-react'
import { ProductGenerateButton } from '@/components/products/product-generate-button'
import { ProductShotTypeSelector } from '@/components/products/product-shot-type-selector'
import { formatDistanceToNow } from 'date-fns'

export default async function ProductDetailPage({
  params,
}: {
  params: Promise<{ productId: string }>
}) {
  const { productId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const { data: product } = await supabase
    .from('products')
    .select(`
      *, stores(id, user_id, shop_name),
      product_images(src, alt, position, is_primary),
      generated_images(id, generated_url, status, updated_at, cloudinary_public_id, templates(id, name))
    `)
    .eq('id', productId)
    .single()

  if (!product || (product as any).stores?.user_id !== user!.id) notFound()

  const images = (product.product_images || []).sort((a: any, b: any) => a.position - b.position)
  const primaryImage = images.find((i: any) => i.is_primary) || images[0]
  const generatedImages = (product.generated_images || [])
    .filter((g: any) => g.status === 'completed')
    .sort((a: any, b: any) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())

  function formatPrice(price: number) {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(price)
  }

  const discount = product.compare_at_price && product.compare_at_price > product.price
    ? Math.round(((product.compare_at_price - product.price) / product.compare_at_price) * 100)
    : 0

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center gap-3">
        <Link href="/dashboard/products">
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-semibold">{product.title}</h1>
          <div className="flex items-center gap-2 mt-1 text-sm text-muted-foreground">
            <span>{formatPrice(product.price)}</span>
            {discount > 0 && (
              <>
                <span className="line-through">{formatPrice(product.compare_at_price)}</span>
                <Badge variant="destructive" className="text-xs py-0">-{discount}%</Badge>
              </>
            )}
            {product.vendor && <Badge variant="outline" className="text-xs py-0">{product.vendor}</Badge>}
            {product.product_type && <Badge variant="outline" className="text-xs py-0">{product.product_type}</Badge>}
          </div>
          {product.tags?.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {product.tags.map((tag: string) => (
                <Badge key={tag} variant="secondary" className="text-xs py-0">{tag}</Badge>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Original vs Generated */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          {/* min-h-8 matches the control row opposite, so both cards start at the
              same y and the two images sit exactly side by side. */}
          <div className="flex items-center min-h-8 mb-2">
            <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Original (Shopify)</h2>
          </div>
          <Card className="overflow-hidden">
            <div className="aspect-square bg-muted">
              {primaryImage ? (
                <img src={primaryImage.src} alt={product.title} className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-muted-foreground">
                  <ImageIcon className="h-8 w-8 opacity-30" />
                </div>
              )}
            </div>
          </Card>
          {images.length > 1 && (
            <div className="flex gap-2 mt-2 overflow-x-auto">
              {images.map((img: any, idx: number) => (
                <div key={idx} className="w-16 h-16 rounded-md bg-muted overflow-hidden flex-shrink-0 border">
                  <img src={img.src} alt="" className="w-full h-full object-cover" />
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          {/* Shot type sits inline with Generate rather than on its own row —
              a second row here offset this card against the original image. */}
          <div className="flex items-center justify-between gap-2 min-h-8 mb-2">
            <h2 className="truncate text-sm font-medium text-muted-foreground uppercase tracking-wide">Generated creative</h2>
            <div className="flex shrink-0 items-center gap-2">
              <ProductShotTypeSelector
                productId={product.id}
                initialValue={(product as any).shot_type_override ?? null}
              />
              <ProductGenerateButton productId={product.id} storeId={(product as any).stores.id} />
            </div>
          </div>

          {generatedImages.length > 0 ? (
            <>
              <Card className="overflow-hidden">
                <div className="aspect-square bg-muted relative group">
                  <img src={generatedImages[0].generated_url} alt="Generated" className="w-full h-full object-cover" />
                  <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-all flex items-center justify-center opacity-0 group-hover:opacity-100">
                    <a href={generatedImages[0].generated_url} download target="_blank" rel="noopener noreferrer">
                      <Button size="sm" variant="secondary">
                        <Download className="h-3.5 w-3.5 mr-1.5" />
                        Download
                      </Button>
                    </a>
                  </div>
                </div>
              </Card>
              <div className="flex items-center justify-between mt-2 text-xs text-muted-foreground">
                <span>Template: {(generatedImages[0] as any).templates?.name}</span>
                <span>Updated {formatDistanceToNow(new Date(generatedImages[0].updated_at), { addSuffix: true })}</span>
              </div>

              {generatedImages.length > 1 && (
                <div className="mt-3">
                  <p className="text-xs text-muted-foreground mb-1.5">Other templates applied</p>
                  <div className="flex gap-2 overflow-x-auto">
                    {generatedImages.slice(1).map((g: any) => (
                      <div key={g.id} className="flex-shrink-0">
                        <div className="w-16 h-16 rounded-md bg-muted overflow-hidden border">
                          <img src={g.generated_url} alt="" className="w-full h-full object-cover" />
                        </div>
                        <p className="text-xs text-center mt-1 text-muted-foreground truncate w-16">{g.templates?.name}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            <Card className="border-dashed">
              <CardContent className="aspect-square flex flex-col items-center justify-center text-muted-foreground">
                <ImageIcon className="h-8 w-8 mb-2 opacity-30" />
                <p className="text-sm">No creative generated yet</p>
                <p className="text-xs mt-1">Click Generate to create one based on your rules</p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}