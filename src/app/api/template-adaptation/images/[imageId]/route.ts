import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getUser } from '@/lib/supabase/get-user'
import { getAdminClient, deleteAdaptationImage } from '@/lib/adaptation-queue'

async function checkOwnership(imageId: string, userId: string, admin: ReturnType<typeof getAdminClient>) {
  const { data: image } = await admin
    .from('adaptation_images').select('id, store_id').eq('id', imageId).maybeSingle()
  if (!image) return null

  const supabase = await createClient()
  const { data: store } = await supabase
    .from('stores').select('id').eq('id', image.store_id).eq('user_id', userId).single()
  if (!store) return null

  return image
}

// PATCH /api/template-adaptation/images/[imageId]  { approved: boolean }
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ imageId: string }> }
) {
  const user = await getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { imageId } = await params
  const admin = getAdminClient()

  const image = await checkOwnership(imageId, user.id, admin)
  if (!image) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { approved } = await request.json()
  if (typeof approved !== 'boolean') {
    return NextResponse.json({ error: 'approved (boolean) required' }, { status: 400 })
  }

  const { error } = await admin
    .from('adaptation_images')
    .update({ approved, updated_at: new Date().toISOString() })
    .eq('id', imageId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, approved })
}

// DELETE /api/template-adaptation/images/[imageId]
// Deletes one image's output only — sibling images and the parent job are untouched.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ imageId: string }> }
) {
  const user = await getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { imageId } = await params
  const admin = getAdminClient()

  const image = await checkOwnership(imageId, user.id, admin)
  if (!image) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  try {
    await deleteAdaptationImage(imageId, admin)
    return NextResponse.json({ success: true })
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Delete failed' }, { status: 500 })
  }
}
