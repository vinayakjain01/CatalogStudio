import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getUser } from '@/lib/supabase/get-user'
import { getAdminClient, deleteAdaptationJob } from '@/lib/adaptation-queue'

// GET /api/template-adaptation/jobs/[jobId] — job row + all its images.
// Polled every ~2s by the frontend while a job is pending/processing.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const user = await getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { jobId } = await params
  const admin = getAdminClient()

  const { data: job } = await admin
    .from('adaptation_jobs').select('*').eq('id', jobId).maybeSingle()
  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const supabase = await createClient()
  const { data: store } = await supabase
    .from('stores').select('id').eq('id', job.store_id).eq('user_id', user.id).single()
  if (!store) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { data: images, error } = await admin
    .from('adaptation_images')
    .select('*')
    .eq('job_id', jobId)
    .order('position', { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ job, images: images || [] })
}

// DELETE /api/template-adaptation/jobs/[jobId] — best-effort Cloudinary
// cleanup (reference + every output), then delete the job (cascades).
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const user = await getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { jobId } = await params
  const admin = getAdminClient()

  const { data: job } = await admin
    .from('adaptation_jobs').select('id, store_id').eq('id', jobId).maybeSingle()
  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const supabase = await createClient()
  const { data: store } = await supabase
    .from('stores').select('id').eq('id', job.store_id).eq('user_id', user.id).single()
  if (!store) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  try {
    await deleteAdaptationJob(jobId, admin)
    return NextResponse.json({ success: true })
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Delete failed' }, { status: 500 })
  }
}
