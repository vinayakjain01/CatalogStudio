import { NextRequest, NextResponse } from 'next/server'
import { processAdaptationBatch } from '@/lib/adaptation-queue'

// Drains the adaptation_images queue. Mirrors /api/cron/generate exactly —
// this is Template Adaptation's third execution path (alongside the BullMQ
// worker and its DB-poll loop in catalog-worker.ts), so the feature still
// works on Vercel even when no separate worker process is running.

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const started = Date.now()
  const BUDGET_MS = 50_000 // leave headroom under maxDuration
  let claimed = 0, completed = 0, failed = 0, ticks = 0

  while (Date.now() - started < BUDGET_MS) {
    const res = await processAdaptationBatch(10, 4)
    claimed += res.claimed
    completed += res.completed
    failed += res.failed
    ticks++
    if (res.claimed === 0) break // queue empty
  }

  return NextResponse.json({ ticks, claimed, completed, failed, ms: Date.now() - started })
}
