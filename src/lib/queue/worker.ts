import { Worker, type Job, type ConnectionOptions } from 'bullmq'
import { getRedisConnection } from './connection'
import { GENERATION_QUEUE, type GenerationJobData } from './queues'
import { processGeneration, markJobStatus } from '@/lib/generation/process'

// ──────────────────────────────────────────────────────────────────────────
// Generation worker (run as a separate process: `npm run worker`)
//
// Consumes the generation queue with bounded concurrency. Job status is
// mirrored into the generation_jobs table so the UI can poll it. Retries are
// handled by BullMQ; we only mark a job `failed` on the FINAL attempt, at which
// point the failed BullMQ job is retained as a dead-letter record.
// ──────────────────────────────────────────────────────────────────────────

const connection = getRedisConnection()

if (!connection) {
  console.error('[worker] REDIS_URL is not set — nothing to consume. Exiting.')
  process.exit(1)
}

const concurrency = Number(process.env.GENERATION_CONCURRENCY ?? 4)

const worker = new Worker<GenerationJobData>(
  GENERATION_QUEUE,
  async (job: Job<GenerationJobData>) => {
    const { jobId } = job.data
    await markJobStatus(jobId, 'processing', { started_at: new Date().toISOString() })

    try {
      const { url, templateId } = await processGeneration(job.data)
      await markJobStatus(jobId, 'completed', {
        progress: 100,
        template_id: templateId,
        generated_url: url,
        completed_at: new Date().toISOString(),
      })
      return { url }
    } catch (err) {
      const attempts = job.opts.attempts ?? 1
      const isFinal = job.attemptsMade + 1 >= attempts
      if (isFinal) {
        await markJobStatus(jobId, 'failed', {
          error: err instanceof Error ? err.message : 'Generation failed',
          completed_at: new Date().toISOString(),
        })
      }
      throw err // let BullMQ schedule the retry / move to failed set
    }
  },
  { connection: connection as ConnectionOptions, concurrency }
)

worker.on('completed', (job) => {
  console.log(`[worker] job ${job.id} completed`)
})

worker.on('failed', (job, err) => {
  console.error(`[worker] job ${job?.id} failed (attempt ${job?.attemptsMade}):`, err.message)
})

console.log(`[worker] generation worker started (concurrency=${concurrency})`)
