import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { deleteImage } from '@/lib/cloudinary'

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ creativeId: string }> }
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { creativeId } = await params

  const { data: creative } = await supabase
    .from('generated_images')
    .select('cloudinary_public_id, product_id, products(store_id, stores(user_id))')
    .eq('id', creativeId)
    .single()

  if (!creative) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Delete from Cloudinary
  if (creative.cloudinary_public_id) {
    try { await deleteImage(creative.cloudinary_public_id) } catch {}
  }

  await supabase.from('generated_images').delete().eq('id', creativeId)
  return NextResponse.json({ success: true })
}