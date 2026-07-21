import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getUser } from '@/lib/supabase/get-user'
import { getAdminClient, cancelAdaptationJob } from '@/lib/adaptation-queue'

// POST /api/template-adaptation/jobs/[jobId]/cancel
// Cancels all pending/generating images for this job. Mirrors /api/generate/cancel.
export async function POST(
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
    const { cancelled } = await cancelAdaptationJob(jobId, admin)
    return NextResponse.json({ cancelled, message: `Cancelled ${cancelled} image(s)` })
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Cancel failed' }, { status: 500 })
  }
}
