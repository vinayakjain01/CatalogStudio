import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { deleteImage } from '@/lib/cloudinary'

/**
 * DELETE /api/creatives/:id
 *
 * Reads from `generated_creatives` (v2), not the legacy `generated_images` —
 * that table has no variant/image dimension, so once a product's variants and
 * images each get their own creative, it can only ever represent the last one
 * written. generated_creatives carries store_id directly, so ownership is a
 * plain join instead of going through products.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ creativeId: string }> }
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { creativeId } = await params

  const { data: creative } = await supabase
    .from('generated_creatives')
    .select('cloudinary_id, stores!inner(user_id)')
    .eq('id', creativeId)
    .single()

  if (!creative || (creative as any).stores?.user_id !== user.id) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  if (creative.cloudinary_id) {
    try { await deleteImage(creative.cloudinary_id) } catch { /* best-effort */ }
  }

  await supabase.from('generated_creatives').delete().eq('id', creativeId)
  return NextResponse.json({ success: true })
}
