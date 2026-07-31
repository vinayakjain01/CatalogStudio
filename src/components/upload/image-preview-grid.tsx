'use client'

/**
 * Preview grid for a scanned folder.
 *
 * Each tile shows thumbnail, filename, resolution, size and upload status, and
 * can be removed before (or after) uploading.
 *
 * Two deliberate performance choices, because a real product folder is hundreds
 * of multi-megabyte images:
 *  - tiles are memoized, so one file finishing its upload re-renders one tile
 *    rather than all 400
 *  - thumbnails are lazy and the grid is capped until the user asks for more,
 *    so the browser never decodes hundreds of full-size photos at once
 */
import { memo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { CheckCircle2, ImageOff, Loader2, Plus, RotateCcw, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatBytes } from '@/lib/uploads/image-files'
import type { ItemStatus, UploadItem } from './use-folder-upload'

const INITIAL_VISIBLE = 60

interface ImagePreviewGridProps {
  items: UploadItem[]
  onRemove: (id: string) => void
  onInclude: (id: string) => void
  onDimensions: (id: string, width: number, height: number) => void
  /** Removal is blocked while the pool is running to avoid mutating in-flight work. */
  busy: boolean
}

export function ImagePreviewGrid({
  items, onRemove, onInclude, onDimensions, busy,
}: ImagePreviewGridProps) {
  const [visible, setVisible] = useState(INITIAL_VISIBLE)

  const shown = items.slice(0, visible)
  const hidden = items.length - shown.length

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {shown.map(item => (
          <PreviewTile
            key={item.id}
            item={item}
            busy={busy}
            onRemove={onRemove}
            onInclude={onInclude}
            onDimensions={onDimensions}
          />
        ))}
      </div>

      {hidden > 0 && (
        <div className="flex justify-center">
          <Button variant="outline" size="lg" onClick={() => setVisible(items.length)}>
            Show all {items.length} images
            <span className="text-muted-foreground">({hidden} more)</span>
          </Button>
        </div>
      )}
    </div>
  )
}

interface PreviewTileProps {
  item: UploadItem
  busy: boolean
  onRemove: (id: string) => void
  onInclude: (id: string) => void
  onDimensions: (id: string, width: number, height: number) => void
}

const PreviewTile = memo(function PreviewTile({
  item, busy, onRemove, onInclude, onDimensions,
}: PreviewTileProps) {
  const [broken, setBroken] = useState(false)
  const isDuplicate = item.status === 'duplicate'

  return (
    <div
      className={cn(
        'group relative overflow-hidden rounded-xl border bg-card transition-all',
        item.status === 'failed' && 'border-destructive/40',
        item.status === 'uploaded' && 'border-green-500/40',
        isDuplicate && 'opacity-60'
      )}
    >
      {/* Thumbnail */}
      <div className="relative aspect-square overflow-hidden bg-muted">
        {broken ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-muted-foreground">
            <ImageOff className="h-5 w-5" />
            <span className="text-[10px]">Unreadable</span>
          </div>
        ) : (
          <img
            src={item.previewUrl}
            alt={item.productName}
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover"
            onLoad={e => {
              const img = e.currentTarget
              if (img.naturalWidth) onDimensions(item.id, img.naturalWidth, img.naturalHeight)
            }}
            onError={() => setBroken(true)}
          />
        )}

        {/* Status veil */}
        {item.status === 'uploading' && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/70 backdrop-blur-[1px]">
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
          </div>
        )}
        {item.status === 'uploaded' && (
          <div className="absolute top-1.5 left-1.5 rounded-full bg-background/90 p-0.5 shadow-sm">
            <CheckCircle2 className="h-4 w-4 text-green-600" />
          </div>
        )}

        {/* Remove / include */}
        {isDuplicate ? (
          <Button
            type="button"
            size="icon-sm"
            variant="secondary"
            title="Include this duplicate anyway"
            className="absolute top-1.5 right-1.5 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            onClick={() => onInclude(item.id)}
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        ) : (
          <Button
            type="button"
            size="icon-sm"
            variant="secondary"
            title="Remove this image"
            disabled={busy || item.status === 'uploading'}
            className="absolute top-1.5 right-1.5 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            onClick={() => onRemove(item.id)}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      {/* Metadata */}
      <div className="space-y-1 p-2.5">
        <p className="truncate text-xs font-medium leading-tight" title={item.relativePath}>
          {item.productName}
        </p>
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="tabular-nums">
            {item.width ? `${item.width}×${item.height}` : '—'}
          </span>
          <span className="opacity-40">·</span>
          <span className="tabular-nums">{formatBytes(item.size)}</span>
        </div>
        <StatusLine status={item.status} error={item.error} />
      </div>
    </div>
  )
})

function StatusLine({ status, error }: { status: ItemStatus; error?: string }) {
  if (status === 'ready') {
    return <p className="text-[11px] text-muted-foreground">Ready</p>
  }
  if (status === 'duplicate') {
    return <Badge variant="outline" className="h-4 px-1.5 text-[10px]">Duplicate — skipped</Badge>
  }
  if (status === 'uploading') {
    return <p className="text-[11px] text-primary">Uploading…</p>
  }
  if (status === 'uploaded') {
    return <p className="text-[11px] text-green-600">Uploaded</p>
  }
  if (status === 'cancelled') {
    return (
      <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
        <RotateCcw className="h-3 w-3" />
        Cancelled
      </p>
    )
  }
  return (
    <p className="line-clamp-2 text-[11px] text-destructive" title={error}>
      {error || 'Failed'}
    </p>
  )
}
