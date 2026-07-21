'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Loader2, Sparkles, Trash2 } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { ReferenceUpload, type UploadedImage } from './reference-upload'
import { ProductImagesUpload } from './product-images-upload'
import type { AdaptationJob, PlatformContext } from '@/types/template-adaptation'

const PLATFORM_OPTIONS: { value: PlatformContext; label: string }[] = [
  { value: 'generic', label: 'Generic / multi-channel' },
  { value: 'shopify_pdp', label: 'Shopify product page' },
  { value: 'meta_feed_ad', label: 'Meta (Facebook/Instagram) ad' },
  { value: 'instagram_post', label: 'Instagram post' },
]

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  pending: 'outline',
  processing: 'secondary',
  completed: 'default',
  partial: 'secondary',
  failed: 'destructive',
  cancelled: 'outline',
}

interface StoreLite {
  id: string
  shop_name: string
  shop_domain: string
}

export function TemplateAdaptationClient({ store }: { store: StoreLite | null }) {
  const router = useRouter()
  const [reference, setReference] = useState<UploadedImage | null>(null)
  const [products, setProducts] = useState<UploadedImage[]>([])
  const [platformContext, setPlatformContext] = useState<PlatformContext>('generic')
  const [merchantNotes, setMerchantNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [jobs, setJobs] = useState<AdaptationJob[]>([])
  const [loadingJobs, setLoadingJobs] = useState(true)

  useEffect(() => {
    if (store) fetchJobs()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store?.id])

  async function fetchJobs() {
    if (!store) return
    setLoadingJobs(true)
    try {
      const res = await fetch(`/api/template-adaptation/jobs?storeId=${store.id}`)
      const data = await res.json()
      setJobs(data.jobs || [])
    } finally {
      setLoadingJobs(false)
    }
  }

  async function handleSubmit() {
    if (!store) return
    setError(null)
    if (!reference) { setError('Upload a reference advertisement first'); return }
    if (products.length === 0) { setError('Upload at least one product photo'); return }

    setSubmitting(true)
    try {
      const res = await fetch('/api/template-adaptation/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          storeId: store.id,
          referenceImageUrl: reference.url,
          referenceCloudinaryId: reference.cloudinaryId,
          platformContext,
          merchantNotes: merchantNotes.trim() || undefined,
          productImages: products.map(p => ({ url: p.url, cloudinaryId: p.cloudinaryId })),
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Failed to start adaptation')
        setSubmitting(false)
        return
      }
      router.push(`/dashboard/template-adaptation/${data.jobId}`)
    } catch (err: any) {
      setError(err.message || 'Failed to start adaptation')
      setSubmitting(false)
    }
  }

  async function handleDeleteJob(jobId: string) {
    if (!confirm('Delete this job and all its generated creatives?')) return
    await fetch(`/api/template-adaptation/jobs/${jobId}`, { method: 'DELETE' })
    setJobs(prev => prev.filter(j => j.id !== jobId))
  }

  if (!store) {
    return <p className="text-muted-foreground">No stores connected.</p>
  }

  return (
    <div className="space-y-8">
      <Card>
        <CardContent className="space-y-5 p-5">
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
            <div>
              <Label className="mb-2 block">Reference advertisement</Label>
              <ReferenceUpload value={reference} onChange={setReference} />
            </div>
            <div>
              <Label className="mb-2 block">Your product photos (1–10)</Label>
              <ProductImagesUpload value={products} onChange={setProducts} />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
            <div>
              <Label className="mb-2 block">Platform</Label>
              <Select value={platformContext} onValueChange={v => setPlatformContext(v as PlatformContext)}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PLATFORM_OPTIONS.map(opt => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="mb-2 block">Styling notes (optional)</Label>
              <Textarea
                placeholder="e.g. keep a warm, editorial tone"
                value={merchantNotes}
                onChange={e => setMerchantNotes(e.target.value)}
                rows={2}
              />
            </div>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {submitting ? 'Starting…' : 'Start Adaptation'}
          </Button>
        </CardContent>
      </Card>

      <div>
        <h2 className="mb-3 text-lg font-semibold">Past jobs</h2>
        {loadingJobs ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : jobs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No Template Adaptation jobs yet.</p>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {jobs.map(job => (
              <Card key={job.id} className="group overflow-hidden">
                <Link href={`/dashboard/template-adaptation/${job.id}`}>
                  <div className="aspect-[3/2] w-full bg-muted">
                    <img src={job.reference_image_url} alt="Reference" className="h-full w-full object-cover" />
                  </div>
                </Link>
                <CardContent className="flex items-center justify-between gap-2 p-3">
                  <div className="min-w-0">
                    <Badge variant={STATUS_VARIANT[job.status] || 'outline'}>{job.status}</Badge>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {job.completed_count}/{job.total_images} done · {formatDistanceToNow(new Date(job.created_at), { addSuffix: true })}
                    </p>
                  </div>
                  <Button size="icon-sm" variant="ghost" onClick={() => handleDeleteJob(job.id)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
