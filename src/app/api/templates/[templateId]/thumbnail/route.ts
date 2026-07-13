import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createSupabaseAdmin } from '@supabase/supabase-js'
import { compositeImage } from '@/lib/compositor'
import { uploadBuffer } from '@/lib/cloudinary'

function getAdminClient() {
  return createSupabaseAdmin(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ templateId: string }> }
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { templateId } = await params

  const { data: template } = await supabase
    .from('templates')
    .select('canvas_data')
    .eq('id', templateId)
    .eq('user_id', user.id)
    .single()

  if (!template) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Find a sample product image from any of the user's stores
  const adminSupabase = getAdminClient()
  const { data: stores } = await supabase.from('stores').select('id').eq('user_id', user.id)
  const storeIds = stores?.map(s => s.id) || []

  let sampleImage: string | null = null
  let sampleProduct = {
    title: 'Sample Product Title',
    price: 1499,
    compare_at_price: 1999,
    vendor: 'Brand Name',
    product_type: 'Apparel',
  }

  if (storeIds.length > 0) {
    const { data: products } = await adminSupabase
      .from('products')
      .select('title, price, compare_at_price, vendor, product_type, product_images(src, is_primary)')
      .in('store_id', storeIds)
      .limit(1)

    if (products && products.length > 0) {
      const p = products[0] as any
      sampleProduct = {
        title: p.title,
        price: p.price,
        compare_at_price: p.compare_at_price,
        vendor: p.vendor,
        product_type: p.product_type,
      }
      const img = p.product_images?.find((i: any) => i.is_primary) || p.product_images?.[0]
      sampleImage = img?.src || null
    }
  }

  try {
    const canvasData = template.canvas_data as any
    const buffer = await compositeImage(canvasData, {
      ...sampleProduct,
      imageUrl: sampleImage,
    }, {
      // Without this, compositeImage() defaults templateMode to 'standard'
      // regardless of what the template is actually configured as — meaning
      // Product Zoom (and AI Product) templates would always render their
      // thumbnail as Standard Mode, ignoring the saved template values.
      templateMode: canvasData.templateMode || 'standard',
    })

    const { deliveredUrl: url } = await uploadBuffer(buffer, `thumbnail_${templateId}`)

    await supabase
      .from('templates')
      .update({ thumbnail_url: url, updated_at: new Date().toISOString() })
      .eq('id', templateId)

    return NextResponse.json({ thumbnail_url: url })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}