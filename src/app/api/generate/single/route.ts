import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createSupabaseAdmin } from '@supabase/supabase-js'
import { resolveTemplateForProduct } from '@/lib/template-resolver'
import { compositeImage } from '@/lib/compositor'
import { uploadBuffer } from '@/lib/cloudinary'
import { getTransparentProductImage } from '@/lib/background-removal'

export const runtime = 'nodejs'
export const maxDuration = 60

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
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { productId, storeId } = await request.json()
  if (!productId || !storeId) {
    return NextResponse.json({ error: 'productId and storeId required' }, { status: 400 })
  }

  // Verify store ownership
  const { data: store } = await supabase
    .from('stores').select('id').eq('id', storeId).eq('user_id', user.id).single()
  if (!store) return NextResponse.json({ error: 'Store not found' }, { status: 404 })

  const adminSupabase = getAdminClient()

  // Load this one product
  const { data: product } = await adminSupabase
    .from('products')
    .select(`id, title, vendor, product_type, tags, price, compare_at_price,
      product_images(src, is_primary)`)
    .eq('id', productId)
    .eq('store_id', storeId)
    .single()

  if (!product) return NextResponse.json({ error: 'Product not found' }, { status: 404 })

  // Resolve rule → template for THIS product
  const templateId = await resolveTemplateForProduct(
    {
      id: product.id,
      tags: product.tags || [],
      vendor: product.vendor,
      product_type: product.product_type,
      price: product.price,
      compare_at_price: product.compare_at_price,
    },
    storeId
  )

  if (!templateId) {
    // No rule matched — do nothing, tell the user clearly.
    return NextResponse.json(
      { generated: 0, message: 'No rule matches this product. Add or adjust a rule in Rules Engine.' },
      { status: 200 }
    )
  }

  const { data: template } = await adminSupabase
    .from('templates').select('canvas_data').eq('id', templateId).single()
  if (!template) return NextResponse.json({ error: 'Matched template not found' }, { status: 404 })

  const images = (product as any).product_images || []
  const primaryImage = images.find((i: any) => i.is_primary) || images[0]
  const imageUrl: string | null = primaryImage?.src || null

  try {
    // ── AI Product Mode: background removal ────────────────────────────────
    // Mirrors the same logic used by the bulk worker (generation-queue.ts).
    // Cached per source image URL — re-generating the same product never
    // re-calls the AI provider.
    const canvasData = template.canvas_data as any
    const templateMode: 'standard' | 'ai_product' = canvasData.templateMode || 'standard'
    let transparentImageUrl: string | null = null

    if (templateMode === 'ai_product' && imageUrl) {
      try {
        const bgResult = await getTransparentProductImage(imageUrl, storeId, adminSupabase)
        transparentImageUrl = bgResult.transparentUrl
        console.log(`[generate/single] BG removal ${bgResult.fromCache ? 'cached' : 'fresh'} for productId=${product.id}`)
      } catch (bgErr: any) {
        console.error(`[generate/single] BG removal failed for productId=${product.id}, falling back to standard:`, bgErr.message)
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    const productLayerSettings = canvasData.productLayerSettings || undefined

    const buffer = await compositeImage(canvasData, {
      title: product.title,
      price: product.price,
      compare_at_price: product.compare_at_price,
      vendor: product.vendor,
      product_type: product.product_type,
      imageUrl,
      transparentImageUrl,
    }, {
      templateMode: transparentImageUrl ? 'ai_product' : 'standard',
      productLayerSettings,
      storeId,
      supabase: adminSupabase,
    })

    if (buffer.length < 1000 || buffer[0] !== 0x89 || buffer[1] !== 0x50) {
      return NextResponse.json({ error: 'Image generation produced an invalid buffer.' }, { status: 500 })
    }

    const publicId = `product_${product.id}_${templateId}_default`
    const { deliveredUrl: url, publicId: cloudPublicId } = await uploadBuffer(buffer, publicId)

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

    return NextResponse.json({ generated: 1, url })
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Generation failed' }, { status: 500 })
  }
}