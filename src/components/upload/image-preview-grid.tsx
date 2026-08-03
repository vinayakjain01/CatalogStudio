'use client'

/**
 * Preview grid for a scanned folder.
 *
 * Each tile shows thumbnail, filename, resolution, size and upload status, and
 * can be removed before (or after) uploading.
 *
 * Three deliberate performance choices, because a real product folder is
 * hundreds of 45-megapixel images:
 *  - PAGE_SIZE tiles at a time. Rendering a whole folder means the browser
 *    decodes every original at full resolution to paint a 200px thumbnail,
 *    which competes with the uploads for CPU and memory.
 *  - tiles are memoized, so one file finishing its upload re-renders one tile
 *    rather than the whole page
 *  - once an image is uploaded its tile switches to a small Cloudinary
 *    thumbnail, so the giant local file no longer has to be decoded at all
 */
import { memo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  CheckCircle2, ChevronLeft, ChevronRight, ImageOff, Loader2, Plus, RotateCcw, X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatBytes } from '@/lib/uploads/image-files'
import type { ItemStatus, UploadItem } from './use-folder-upload'

const PAGE_SIZE = 5

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
  const [page, setPage] = useState(1)

  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE))
  // Derived rather than corrected in an effect: removing items can drop the
  // page count below the current page, and clamping here avoids a blank render.
  const currentPage = Math.min(page, totalPages)

  const from = (currentPage - 1) * PAGE_SIZE
  const shown = items.slice(from, from + PAGE_SIZE)

  if (items.length === 0) return null

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
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

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <p className="text-muted-foreground">
            Showing {from + 1}–{Math.min(from + PAGE_SIZE, items.length)} of {items.length}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(currentPage - 1)}
              disabled={currentPage <= 1}
            >
              <ChevronLeft className="h-4 w-4" />
              Previous
            </Button>
            <span className="px-2 text-muted-foreground tabular-nums">
              Page {currentPage} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(currentPage + 1)}
              disabled={currentPage >= totalPages}
            >
              Next
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Prefer a small Cloudinary rendition once the image has landed there.
 *
 * The local object URL points at the untouched original — asking the browser to
 * decode 45 MP to fill a 200px tile is the single most expensive thing this grid
 * can do, and it is pure waste once a hosted copy exists.
 */
function thumbnailSrc(item: UploadItem): string {
  if (item.imageUrl && item.imageUrl.includes('/upload/')) {
    return item.imageUrl.replace('/upload/', '/upload/w_400,c_limit,f_auto,q_auto/')
  }
  return item.previewUrl
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
            src={thumbnailSrc(item)}
            alt={item.productName}
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover"
            onLoad={e => {
              const img = e.currentTarget
              // Only the local original reports true source dimensions; the
              // Cloudinary rendition is deliberately downscaled.
              if (img.naturalWidth && img.currentSrc === item.previewUrl) {
                onDimensions(item.id, img.naturalWidth, img.naturalHeight)
              }
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
