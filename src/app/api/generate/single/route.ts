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

  const { productId, storeId } = await request.json()
  if (!productId || !storeId) {
    return NextResponse.json({ error: 'productId and storeId required' }, { status: 400 })
  }

  // Verify ownership
  const { data: store } = await supabase
    .from('stores')
    .select('id')
    .eq('id', storeId)
    .eq('user_id', user.id)
    .single()

  if (!store) return NextResponse.json({ error: 'Store not found' }, { status: 404 })

  const adminSupabase = getAdminClient()

  const { data: product } = await adminSupabase
    .from('products')
    .select('id, title, vendor, product_type, tags, price, compare_at_price, product_images(src, is_primary)')
    .eq('id', productId)
    .eq('store_id', storeId)
    .single()

  if (!product) return NextResponse.json({ error: 'Product not found' }, { status: 404 })

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
    return NextResponse.json({ error: 'No matching rule found for this product. Set up a rule first.' }, { status: 400 })
  }

  const { data: template } = await adminSupabase
    .from('templates')
    .select('canvas_data')
    .eq('id', templateId)
    .single()

  if (!template) return NextResponse.json({ error: 'Template not found' }, { status: 404 })

  const images = (product as any).product_images || []
  const primaryImage = images.find((i: any) => i.is_primary) || images[0]

  try {
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

    const publicId = `product_${product.id}_${templateId}`
    const { deliveredUrl: url, publicId: cloudPublicId } = await uploadBuffer(buffer, publicId)

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

    return NextResponse.json({ success: true, url })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}