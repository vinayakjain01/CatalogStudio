'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { ResultImageCard } from './result-image-card'
import { ArrowLeft, StopCircle, AlertTriangle, Loader2 } from 'lucide-react'
import type { AdaptationJob, AdaptationImage } from '@/types/template-adaptation'

const TERMINAL_STATUSES = new Set(['completed', 'partial', 'failed', 'cancelled'])

const STATUS_LABEL: Record<string, string> = {
  pending: 'Queued',
  processing: 'Generating',
  completed: 'Completed',
  partial: 'Partially completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

export function JobProgressGallery({ jobId }: { jobId: string }) {
  const [job, setJob] = useState<AdaptationJob | null>(null)
  const [images, setImages] = useState<AdaptationImage[]>([])
  const [loading, setLoading] = useState(true)
  const [cancelling, setCancelling] = useState(false)
  const pollingActive = useRef(true)

  async function fetchJob() {
    try {
      const res = await fetch(`/api/template-adaptation/jobs/${jobId}`)
      if (!res.ok) return
      const data = await res.json()
      setJob(data.job)
      setImages(data.images || [])
      return data.job as AdaptationJob
    } finally {
      setLoading(false)
    }
  }

  async function pollUntilTerminal() {
    if (!pollingActive.current) return
    const current = await fetchJob()
    if (!pollingActive.current) return
    if (current && TERMINAL_STATUSES.has(current.status)) {
      pollingActive.current = false
      return
    }
    setTimeout(pollUntilTerminal, 2000)
  }

  useEffect(() => {
    pollingActive.current = true
    pollUntilTerminal()
    return () => { pollingActive.current = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId])

  async function handleCancel() {
    setCancelling(true)
    try {
      await fetch(`/api/template-adaptation/jobs/${jobId}/cancel`, { method: 'POST' })
      await fetchJob()
    } finally {
      setCancelling(false)
    }
  }

  async function handleRetry(imageId: string) {
    await fetch(`/api/template-adaptation/images/${imageId}/retry`, { method: 'POST' })
    // Retrying a single image can move the job out of a terminal status
    // (e.g. 'failed' -> 'processing') — resume polling if it had stopped.
    if (!pollingActive.current) {
      pollingActive.current = true
      pollUntilTerminal()
    } else {
      await fetchJob()
    }
  }

  async function handleApprove(imageId: string, approved: boolean) {
    await fetch(`/api/template-adaptation/images/${imageId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved }),
    })
    setImages(prev => prev.map(img => img.id === imageId ? { ...img, approved } : img))
  }

  async function handleDelete(imageId: string) {
    await fetch(`/api/template-adaptation/images/${imageId}`, { method: 'DELETE' })
    setImages(prev => prev.filter(img => img.id !== imageId))
  }

  if (loading && !job) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading job…
      </div>
    )
  }

  if (!job) {
    return <p className="text-muted-foreground">Job not found.</p>
  }

  const done = job.completed_count + job.failed_count
  const progressPercent = job.total_images > 0 ? Math.round((done / job.total_images) * 100) : 0
  const isActive = job.status === 'pending' || job.status === 'processing'

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <Link href="/dashboard/template-adaptation" className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Back to Template Adaptation
        </Link>
        {isActive && (
          <Button size="sm" variant="outline" disabled={cancelling} onClick={handleCancel}>
            <StopCircle className="h-3.5 w-3.5" /> {cancelling ? 'Cancelling…' : 'Cancel'}
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <img src={job.reference_image_url} alt="Reference" className="h-20 w-16 rounded-md border object-cover" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex items-center gap-2">
            <Badge variant={job.status === 'failed' ? 'destructive' : job.status === 'completed' ? 'default' : 'secondary'}>
              {STATUS_LABEL[job.status] || job.status}
            </Badge>
            <span className="text-sm text-muted-foreground">
              {done}/{job.total_images} done{job.failed_count > 0 ? ` · ${job.failed_count} failed` : ''}
            </span>
          </div>
          <Progress value={progressPercent} />
        </div>
      </div>

      {job.status === 'partial' && (
        <Alert variant="warning">
          <AlertTriangle />
          <AlertTitle>Some images failed</AlertTitle>
          <AlertDescription>
            {job.failed_count} of {job.total_images} product photos failed to generate. Retry them individually below.
          </AlertDescription>
        </Alert>
      )}
      {job.status === 'failed' && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>All generations failed</AlertTitle>
          <AlertDescription>Check the error on each image below, then retry.</AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {images.map(image => (
          <ResultImageCard
            key={image.id}
            image={image}
            onRetry={handleRetry}
            onApprove={handleApprove}
            onDelete={handleDelete}
          />
        ))}
      </div>
    </div>
  )
}
