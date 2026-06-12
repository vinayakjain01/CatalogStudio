import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createSupabaseAdmin } from '@supabase/supabase-js'
import { resolveTemplateForProduct } from '@/lib/template-resolver'
import { compositeImage } from '@/lib/compositor'
import { uploadBuffer } from '@/lib/cloudinary'

function getAdminClient() {
  return createSupabaseAdmin(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const { storeId, filter } = body
  // filter: { type: 'all' | 'tag' | 'vendor' | 'product_type', value?: string }

  if (!storeId) return NextResponse.json({ error: 'storeId required' }, { status: 400 })

  // Verify store ownership
  const { data: store } = await supabase
    .from('stores')
    .select('id')
    .eq('id', storeId)
    .eq('user_id', user.id)
    .single()

  if (!store) return NextResponse.json({ error: 'Store not found' }, { status: 404 })

  // Build product query
  const adminSupabase = getAdminClient()
  let productQuery = adminSupabase
    .from('products')
    .select(`id, title, vendor, product_type, tags, price, compare_at_price,
      product_images(src, is_primary)`)
    .eq('store_id', storeId)
    .eq('status', 'active')

  if (filter?.type === 'tag' && filter.value) {
    productQuery = productQuery.contains('tags', [filter.value])
  } else if (filter?.type === 'vendor' && filter.value) {
    productQuery = productQuery.eq('vendor', filter.value)
  } else if (filter?.type === 'product_type' && filter.value) {
    productQuery = productQuery.eq('product_type', filter.value)
  }

  const { data: products } = await productQuery.limit(100)
  if (!products || products.length === 0) {
    return NextResponse.json({ message: 'No products found', generated: 0 })
  }

  // Kick off generation — return immediately, process in background
  // For MVP we process synchronously (max 100 products per call)
  let generated = 0
  const errors: string[] = []

  for (const product of products) {
    try {
      // Resolve which template to use
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

      if (!templateId) continue // no matching rule

      // Fetch template
      const { data: template } = await adminSupabase
        .from('templates')
        .select('canvas_data')
        .eq('id', templateId)
        .single()

      if (!template) continue

      // Get primary product image
      const images = (product as any).product_images || []
      const primaryImage = images.find((i: any) => i.is_primary) || images[0]

      // Composite image
      const buffer = await compositeImage(template.canvas_data as any, {
        title: product.title,
        price: product.price,
        compare_at_price: product.compare_at_price,
        vendor: product.vendor,
        product_type: product.product_type,
        imageUrl: primaryImage?.src || null,
      })

      // Sanity check — a valid JPEG starts with FF D8 FF
        if (buffer.length < 1000 || buffer[0] !== 0x89 || buffer[1] !== 0x50) {
        return NextResponse.json(
            { error: 'Image generation produced an invalid buffer. Canvas library may not be supported on this runtime.' },
            { status: 500 }
        )
        }

      // Upload to Cloudinary
      const publicId = `product_${product.id}_${templateId}`
      const { deliveredUrl: url, publicId: cloudPublicId } = await uploadBuffer(buffer, publicId)

      // Save to generated_images
      await adminSupabase
        .from('generated_images')
        .upsert(
          {
            product_id: product.id,
            template_id: templateId,
            cloudinary_public_id: cloudPublicId,
            generated_url: url,
            status: 'completed',
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'product_id,template_id' }
        )

      generated++
    } catch (err: any) {
      errors.push(`${product.title}: ${err.message}`)
    }
  }

  return NextResponse.json({ generated, errors: errors.slice(0, 5), total: products.length })
}