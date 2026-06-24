import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { processBatch } from '@/lib/generation-queue'

// Browser-triggered queue drain. Lets generation work WITHOUT a worker or a
// per-minute cron (which Vercel Hobby disallows). The Creatives page calls this
// repeatedly after enqueueing until the queue is empty.
//
// Auth: requires a logged-in user (not CRON_SECRET) since the browser calls it.
//
//   POST /api/generate/drain  ->  { claimed, completed, failed }

export const runtime = 'nodejs'
export const maxDuration = 60

export async function POST(_request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const started = Date.now()
  const BUDGET_MS = 50_000
  let claimed = 0, completed = 0, failed = 0

  // Drain in a loop until time budget runs low or the queue empties.
  while (Date.now() - started < BUDGET_MS) {
    const res = await processBatch(10, 4)
    claimed += res.claimed
    completed += res.completed
    failed += res.failed
    if (res.claimed === 0) break
  }

  return NextResponse.json({ claimed, completed, failed, ms: Date.now() - started })
}