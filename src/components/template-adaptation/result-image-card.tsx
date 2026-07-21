'use client'

import { useState } from 'react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Download, RefreshCw, Trash2, CheckCircle2, Loader2, XCircle } from 'lucide-react'
import type { AdaptationImage } from '@/types/template-adaptation'

interface ResultImageCardProps {
  image: AdaptationImage
  onRetry: (imageId: string) => Promise<void> | void
  onApprove: (imageId: string, approved: boolean) => Promise<void> | void
  onDelete: (imageId: string) => Promise<void> | void
}

const STATUS_BADGE: Record<AdaptationImage['status'], { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  pending: { label: 'Queued', variant: 'outline' },
  generating: { label: 'Generating…', variant: 'secondary' },
  completed: { label: 'Completed', variant: 'default' },
  failed: { label: 'Failed', variant: 'destructive' },
  cancelled: { label: 'Cancelled', variant: 'outline' },
}

export function ResultImageCard({ image, onRetry, onApprove, onDelete }: ResultImageCardProps) {
  const [busy, setBusy] = useState(false)
  const badge = STATUS_BADGE[image.status]

  async function withBusy(fn: () => Promise<void> | void) {
    setBusy(true)
    try { await fn() } finally { setBusy(false) }
  }

  return (
    <Card className="overflow-hidden">
      <div className="relative aspect-[3/4] w-full bg-muted">
        {image.status === 'pending' && <Skeleton className="h-full w-full rounded-none" />}
        {image.status === 'generating' && (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin" />
            <span className="text-xs">Adapting…</span>
          </div>
        )}
        {image.status === 'completed' && image.output_url && (
          <Tabs defaultValue="after" className="h-full">
            <TabsContent value="before" className="m-0 h-full">
              <img src={image.product_image_url} alt="Original product photo" className="h-full w-full object-cover" />
            </TabsContent>
            <TabsContent value="after" className="m-0 h-full">
              <img src={image.output_url} alt="Adapted advertisement" className="h-full w-full object-cover" />
            </TabsContent>
            <TabsList className="absolute top-2 left-2">
              <TabsTrigger value="before">Before</TabsTrigger>
              <TabsTrigger value="after">After</TabsTrigger>
            </TabsList>
          </Tabs>
        )}
        {image.status === 'failed' && (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-3 text-center text-muted-foreground">
            <XCircle className="h-6 w-6 text-destructive" />
            <span className="text-xs">{image.error || 'Generation failed'}</span>
          </div>
        )}
        {image.status === 'cancelled' && (
          <div className="flex h-full w-full items-center justify-center text-muted-foreground">
            <img src={image.product_image_url} alt="Original product photo" className="h-full w-full object-cover opacity-40" />
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 p-2.5">
        <Badge variant={badge.variant}>{badge.label}</Badge>
        <div className="flex items-center gap-1">
          {image.status === 'completed' && image.output_url && (
            <>
              <Button
                size="icon-sm"
                variant={image.approved ? 'default' : 'ghost'}
                title={image.approved ? 'Approved' : 'Approve'}
                disabled={busy}
                onClick={() => withBusy(() => onApprove(image.id, !image.approved))}
              >
                <CheckCircle2 className="h-3.5 w-3.5" />
              </Button>
              <Button size="icon-sm" variant="ghost" title="Download" asChild>
                <a href={image.output_url} download>
                  <Download className="h-3.5 w-3.5" />
                </a>
              </Button>
            </>
          )}
          {(image.status === 'failed' || image.status === 'completed') && (
            <Button
              size="icon-sm"
              variant="ghost"
              title="Retry"
              disabled={busy}
              onClick={() => withBusy(() => onRetry(image.id))}
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button
            size="icon-sm"
            variant="ghost"
            title="Delete"
            disabled={busy}
            onClick={() => {
              if (confirm('Delete this product photo and its result?')) withBusy(() => onDelete(image.id))
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </Card>
  )
}
