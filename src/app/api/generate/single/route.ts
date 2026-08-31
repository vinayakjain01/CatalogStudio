/**
 * POST /api/generate/single
 *
 * Generate one creative for a single product (optionally a specific variant
 * and/or source image), used by the Products list and product detail page.
 * Resolves the matching template rule and does not touch any other product.
 *
 * Auth:    Supabase session (getUser())
 * Rate:    rateLimit(`single:${user.id}`) — max 60 requests per user per hour
 *          (SINGLE_GEN_LIMIT / SINGLE_GEN_WINDOW_SECS)
 * Body:    { productId: string, storeId: string, variantId?: string, imageId?: string, assetType?: 'catalog'|'feed'|'story'|'reel' }
 *          assetType defaults to 'catalog'; an invalid value silently falls back to it rather than erroring.
 * Returns: { generated: 1, url } on success; { generated: 0, message } when no
 *          rule matches; { error } on failure
 *
 * Flow: verify user -> rate limit -> verify store ownership -> load product ->
 * resolve template rule -> pick source image -> (ai_product mode) fetch
 * product layer bundle -> load variant overrides -> composite image ->
 * upload to Cloudinary -> upsert generated_images -> mirror into creatives.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createSupabaseAdmin } from '@supabase/supabase-js'
import { resolveTemplateForProductAndAssetType } from '@/lib/template-resolver'
import { compositeImage } from '@/lib/compositor'
import { uploadBuffer } from '@/lib/cloudinary'
import { recordCreative } from '@/lib/creatives'
import { getProductLayerBundle } from '@/lib/product-layer-engine'
import { getUser } from '@/lib/supabase/get-user'
import { rateLimit, rateLimitHeaders } from '@/lib/rate-limit'
import { ALL_ASSET_TYPES, ASSET_TYPE_CONFIG, type AspectRatio, type AssetType } from '@/types/template'

const SINGLE_GEN_LIMIT = 60
const SINGLE_GEN_WINDOW_SECS = 3600

export const runtime = 'nodejs'
// Was 60s; bumped since the optional Background Reconstruction step
// (backgroundSettings.mode === 'original') can itself take up to 60s
// (Cloudinary Generative Remove polling — see background-reconstruction/index.ts),
// on top of background removal + compositing + upload for everyone else.
export const maxDuration = 120

function getAdminClient() {
  // Node.js 20 (and the Vercel Node runtime in some regions) has no native
  // WebSocket global — Supabase Realtime needs it passed explicitly or the
  // client throws "supabaseKey is required" / WebSocket errors on use.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ws = require('ws') as any
  return createSupabaseAdmin(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { realtime: { transport: ws } }
  )
}

// Generate a creative for ONE product only.
// Resolves the rule for this product; if no rule matches, returns a clear
// message and generates nothing. Does NOT touch any other product.
//
//   POST /api/generate/single  { productId, storeId }
export async function POST(request: NextRequest) {
  const [user, body] = await Promise.all([getUser(), request.json()])
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // variantId is optional: omitted, this renders a product-level creative from
  // the flattened variant[0] values, which is what the Products list uses.
  const { productId, storeId, variantId, imageId } = body
  if (!productId || !storeId) {
    return NextResponse.json({ error: 'productId and storeId required' }, { status: 400 })
  }
  const assetType: AssetType = ALL_ASSET_TYPES.includes(body.assetType) ? body.assetType : 'catalog'

  // Rate limit: max 60 single generations per user per hour
  const rl = await rateLimit(`single:${user.id}`, SINGLE_GEN_LIMIT, SINGLE_GEN_WINDOW_SECS)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: `Rate limit reached. Try again in ${rl.resetIn}s.` },
      { status: 429, headers: rateLimitHeaders(rl) }
    )
  }

  // Verify store ownership
  const supabase = await createClient()
  const { data: store } = await supabase
    .from('stores').select('id').eq('id', storeId).eq('user_id', user.id).single()
  if (!store) return NextResponse.json({ error: 'Store not found' }, { status: 404 })

  const adminSupabase = getAdminClient()

  // Load this one product
  const { data: product } = await adminSupabase
    .from('products')
    .select(`id, title, vendor, product_type, tags, price, compare_at_price, shot_type_override,
      product_images(id, src, cloudinary_url, is_primary, position)`)
    .eq('id', productId)
    .eq('store_id', storeId)
    .single()

  if (!product) return NextResponse.json({ error: 'Product not found' }, { status: 404 })

  // Resolve rule → template for THIS product, restricted to templates
  // targeting the requested placement.
  const templateId = await resolveTemplateForProductAndAssetType(
    {
      id: product.id,
      tags: product.tags || [],
      vendor: product.vendor,
      product_type: product.product_type,
      price: product.price,
      compare_at_price: product.compare_at_price,
    },
    storeId,
    assetType
  )

  if (!templateId) {
    // No rule matched — do nothing, tell the user clearly.
    return NextResponse.json(
      {
        generated: 0,
        message: assetType === 'catalog'
          ? 'No rule matches this product. Add or adjust a rule in Rules Engine.'
          : `No ${assetType} template rule matches this product. Add or adjust a rule in Rules Engine.`,
      },
      { status: 200 }
    )
  }

  const { data: template } = await adminSupabase
    .from('templates').select('canvas_data').eq('id', templateId).single()
  if (!template) return NextResponse.json({ error: 'Matched template not found' }, { status: 404 })

  // Composite from the image the merchant is actually looking at. Without this
  // the detail page's thumbnail strip was decorative: every creative rendered
  // the primary photo no matter which of the five was on screen.
  const images = (product as any).product_images || []
  const chosenImage =
    (imageId && images.find((i: any) => i.id === imageId)) ||
    images.find((i: any) => i.is_primary) ||
    images[0]
  const imageUrl: string | null = chosenImage?.cloudinary_url || chosenImage?.src || null

  try {
    // ── AI Product Mode: background removal ────────────────────────────────
    // Mirrors the same logic used by the bulk worker (generation-queue.ts).
    // Cached per source image URL — re-generating the same product never
    // re-calls the AI provider.
    const canvasData = template.canvas_data as any
    const templateMode: 'standard' | 'ai_product' | 'product_zoom' = canvasData.templateMode || 'standard'

    // ── Product Layer Bundle (matches generation-queue pipeline exactly) ───────
    // Use the same getProductLayerBundle() call as the worker queue so that
    // preview generation and bulk generation always produce identical results.
    // Passing a `productLayerBundle` to the compositor provides:
    //   1. transparentUrl  — cutout PNG for drawProductLayer
    //   2. backgroundUrl   — Background Plate (AI-removed backdrop) for serverRenderBackground
    //   3. metadata        — head/feet coords for Smart Fit 2.0 positioning
    // Without this, the single route used getTransparentProductImage() + getReconstructedBackground()
    // separately, which could produce different background rendering than the worker.
    let productLayerBundle: import('@/types/product-layer').ProductLayerBundle | null = null

    if (templateMode === 'ai_product' && imageUrl) {
      try {
        const bundle = await getProductLayerBundle(imageUrl, storeId, adminSupabase)
        productLayerBundle = bundle
        console.log(
          `[generate/single] Bundle ${bundle.fromCache ? 'cached' : 'fresh'} ` +
          `status=${bundle.bundleStatus} shot=${bundle.metadata?.shot_type} ` +
          `bgPlate=${bundle.backgroundUrl ? 'yes' : 'no'} productId=${product.id}`
        )
      } catch (bundleErr: any) {
        console.error(`[generate/single] Bundle failed, falling back to standard:`, bundleErr.message)
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Load the selected variant so its own price, stock and options drive the
    // dynamic fields and conditional badges. Without this the page's variant
    // picker was cosmetic — every variant rendered variant[0]'s numbers.
    let variant: any = null
    if (variantId) {
      const { data } = await adminSupabase
        .from('product_variants')
        .select('id, title, sku, price, compare_at_price, inventory_quantity, is_sold_out, option1, option2, option3')
        .eq('id', variantId)
        .eq('product_id', product.id)   // scoped: a variant of another product must not render here
        .single()
      variant = data ?? null
    }

    const productLayerSettings = canvasData.productLayerSettings || undefined

    // Placement dimensions come from the requested assetType, not the
    // template's own stored canvas_data.width/height — same override the
    // bulk pipeline applies in generation-queue.ts's runJob, so a preview
    // generated here matches what a bulk run for the same asset type produces.
    const assetConfig = ASSET_TYPE_CONFIG[assetType]
    const renderCanvas = {
      ...canvasData,
      width: assetConfig.width,
      height: assetConfig.height,
      aspectRatio: assetConfig.aspectRatio as AspectRatio,
    }

    const buffer = await compositeImage(renderCanvas, {
      title: product.title,
      price: variant?.price ?? product.price,
      compare_at_price: variant?.compare_at_price ?? product.compare_at_price,
      vendor: product.vendor,
      product_type: product.product_type,
      imageUrl,
      sku:                variant?.sku ?? null,
      variant_title:      variant?.title ?? null,
      inventory_quantity: variant?.inventory_quantity ?? null,
      is_sold_out:        variant?.is_sold_out ?? null,
      option1:            variant?.option1 ?? null,
      option2:            variant?.option2 ?? null,
      option3:            variant?.option3 ?? null,
      transparentImageUrl: productLayerBundle?.transparentUrl ?? null,
      shotTypeOverride: (product as any).shot_type_override ?? null,
      reconstructedBackgroundUrl: null,   // handled by bundle.backgroundUrl now
    }, {
      templateMode,
      productLayerSettings,
      storeId,
      supabase:           adminSupabase,
      productLayerBundle: productLayerBundle ?? undefined,
    })

    // JPEG output sanity check — FF D8 = JPEG Start Of Image marker.
    // (The compositor was switched from PNG to JPEG output for speed.
    // The old PNG check 0x89 0x50 caused every single-generate to return
    // "Image generation produced an invalid buffer" for valid JPEG output.)
    if (buffer.length < 1000 || buffer[0] !== 0xFF || buffer[1] !== 0xD8) {
      return NextResponse.json({ error: 'Image generation produced an invalid buffer.' }, { status: 500 })
    }

    // Variant-scoped public_id, or every variant of a product would overwrite
    // the same Cloudinary asset and leave one creative where there should be many.
    // Image id is part of the public_id too, so generating from a second photo
    // adds a creative rather than overwriting the first. assetType (not the
    // fixed 'default' creative_type) keeps a catalog and a feed/story/reel
    // preview of the same variant+image+template from colliding.
    const publicId = [
      'product', product.id,
      variant ? variant.id : null,
      chosenImage?.id ?? null,
      templateId, assetType,
    ].filter(Boolean).join('_')
    const { deliveredUrl: url, publicId: cloudPublicId } = await uploadBuffer(buffer, publicId, `catalog-creatives/${assetType}`)

    const { error: upsertError } = await adminSupabase
      .from('generated_images')
      .upsert(
        {
          product_id: product.id,
          template_id: templateId,
          creative_type: 'default',
          cloudinary_public_id: cloudPublicId,
          generated_url: url,
          status: 'completed',
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'product_id,template_id,creative_type' }
      )

    if (upsertError) {
      return NextResponse.json({ error: `Save failed: ${upsertError.message}` }, { status: 500 })
    }

    // Mirror into the v2 table the products UI and Meta feed read from.
    await recordCreative({
      supabase: adminSupabase,
      storeId,
      productId: product.id,
      variantId: variant?.id ?? null,
      imageId: chosenImage?.id ?? null,
      templateId,
      url,
      cloudinaryId: cloudPublicId,
      assetType,
    })

    return NextResponse.json({ generated: 1, url })
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Generation failed' }, { status: 500 })
  }
}