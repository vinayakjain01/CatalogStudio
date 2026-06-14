import { NextRequest, NextResponse } from 'next/server'
import { processBatch } from '@/lib/generation-queue'

// Drains the generation_jobs queue. Configured in vercel.json to run every
// minute. Each invocation processes several batches until it runs low on time,
// so a 1000-job backlog clears over a few minutes without any extra infra.

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
    const res = await processBatch(10, 4)
    claimed += res.claimed
    completed += res.completed
    failed += res.failed
    ticks++
    if (res.claimed === 0) break // queue empty
  }

  return NextResponse.json({ ticks, claimed, completed, failed, ms: Date.now() - started })
}