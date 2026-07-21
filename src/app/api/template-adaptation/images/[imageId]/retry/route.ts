import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getUser } from '@/lib/supabase/get-user'
import { getAdminClient, retryAdaptationImage } from '@/lib/adaptation-queue'

// POST /api/template-adaptation/images/[imageId]/retry
// Resets one image to pending (attempts=0) and re-enqueues just that one —
// sibling images in the same job are untouched.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ imageId: string }> }
) {
  const user = await getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { imageId } = await params
  const admin = getAdminClient()

  const { data: image } = await admin
    .from('adaptation_images').select('id, store_id').eq('id', imageId).maybeSingle()
  if (!image) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const supabase = await createClient()
  const { data: store } = await supabase
    .from('stores').select('id').eq('id', image.store_id).eq('user_id', user.id).single()
  if (!store) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  try {
    await retryAdaptationImage(imageId, admin)
    return NextResponse.json({ success: true })
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Retry failed' }, { status: 500 })
  }
}
