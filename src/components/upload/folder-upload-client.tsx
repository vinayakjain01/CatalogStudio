'use client'

/**
 * Folder Upload — the entry point for getting product images into Craftify.
 *
 * Replaces the Google Drive import. Everything downstream of "images are in
 * Cloudinary and products exist" is untouched: the same auto-created
 * `line_sheet` catalog, the same products, the same Excel export by import id.
 *
 * States: pick → preview → uploading → done, each with its own error surface.
 */
import { useCallback, useRef, useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import {
  AlertCircle, ArrowRight, CheckCircle2, Download, FolderOpen, FolderUp,
  ImageIcon, Loader2, RotateCcw, Sparkles, Upload, Wand2, X, XCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { IMAGE_ACCEPT_ATTRIBUTE } from '@/lib/uploads/image-files'
import { fromDataTransfer, fromFileList, MAX_PICKED_FILES } from '@/lib/uploads/pick-files'
import { ImagePreviewGrid } from './image-preview-grid'
import { useFolderUpload } from './use-folder-upload'

/**
 * Directory-upload attributes. Non-standard (hence absent from React's JSX
 * types) but supported by every current browser; `directory` is the legacy
 * spelling kept for older engines. Spread as a typed record rather than written
 * inline so no per-attribute type suppression is needed.
 */
const DIRECTORY_PICKER_PROPS = {
  webkitdirectory: 'true',
  directory: 'true',
} as Record<string, string>

export function FolderUploadClient() {
  const upload = useFolderUpload()
  const { phase, items, counts, summary, session, fatalError } = upload

  const folderInputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)
  const [dropBusy, setDropBusy] = useState(false)

  const handleDrop = useCallback(async (event: React.DragEvent) => {
    event.preventDefault()
    setDragOver(false)
    setDropBusy(true)
    try {
      const picked = await fromDataTransfer(event.dataTransfer)
      upload.selectFiles(picked)
    } finally {
      setDropBusy(false)
    }
  }, [upload])

  const busy = phase === 'uploading' || dropBusy
  const showPicker = phase === 'idle' || phase === 'scanning'

  return (
    <div className="space-y-5">

      {/* ── Pick a folder ──────────────────────────────────────────────────── */}
      {showPicker && (
        <Card>
          <CardContent className="p-0">
            <div
              onDragOver={e => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              onClick={() => !busy && folderInputRef.current?.click()}
              className={cn(
                'flex cursor-pointer flex-col items-center justify-center gap-4 rounded-xl border-2 border-dashed px-6 py-16 text-center transition-colors',
                dragOver ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40'
              )}
            >
              <div className={cn(
                'flex h-16 w-16 items-center justify-center rounded-2xl transition-colors',
                dragOver ? 'bg-primary/15' : 'bg-muted'
              )}>
                {phase === 'scanning' || dropBusy
                  ? <Loader2 className="h-7 w-7 animate-spin text-primary" />
                  : <FolderUp className={cn('h-7 w-7', dragOver ? 'text-primary' : 'text-muted-foreground')} />}
              </div>

              <div className="space-y-1">
                <p className="text-lg font-semibold">
                  {phase === 'scanning' || dropBusy ? 'Scanning folder…' : 'Drop your product folder here'}
                </p>
                <p className="text-sm text-muted-foreground">
                  Every image inside is found automatically, including subfolders
                </p>
              </div>

              <div className="flex flex-wrap items-center justify-center gap-2">
                <Button
                  size="lg"
                  disabled={busy}
                  onClick={e => { e.stopPropagation(); folderInputRef.current?.click() }}
                >
                  <FolderOpen className="h-4 w-4" />
                  Browse folder
                </Button>
                <Button
                  size="lg"
                  variant="outline"
                  disabled={busy}
                  onClick={e => { e.stopPropagation(); fileInputRef.current?.click() }}
                >
                  <ImageIcon className="h-4 w-4" />
                  Select images
                </Button>
              </div>

              <p className="text-xs text-muted-foreground">
                JPG · PNG · WEBP · AVIF — up to {MAX_PICKED_FILES.toLocaleString('en-IN')} images
              </p>
            </div>

            {/* Flow preview — sets expectations before the user commits a folder */}
            <div className="border-t p-5">
              <p className="mb-3 text-xs font-medium text-muted-foreground">WHAT HAPPENS</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {[
                  { icon: FolderOpen, text: 'Every image in the folder is detected' },
                  { icon: Upload,     text: 'Images upload straight into your library' },
                  { icon: Wand2,      text: 'Products appear with thumbnails, ready to use' },
                  { icon: Sparkles,   text: 'Apply templates → generate creatives → export' },
                ].map(({ icon: Icon, text }, i) => (
                  <div key={i} className="flex items-center gap-3 text-sm">
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10">
                      <Icon className="h-3.5 w-3.5 text-primary" />
                    </div>
                    <span className="text-muted-foreground">{text}</span>
                  </div>
                ))}
              </div>
            </div>

            {fatalError && (
              <div className="border-t bg-destructive/5 p-4">
                <div className="flex items-start gap-2.5 text-sm">
                  <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                  <p className="font-medium text-destructive">{fatalError}</p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Hidden inputs. `webkitdirectory` is the directory-upload capability —
          it is what makes the browser hand us a whole tree on every platform. */}
      <input
        ref={folderInputRef}
        type="file"
        {...DIRECTORY_PICKER_PROPS}
        multiple
        className="hidden"
        onChange={e => { upload.selectFiles(fromFileList(e.target.files ?? [])); e.target.value = '' }}
      />
      <input
        ref={fileInputRef}
        type="file"
        accept={IMAGE_ACCEPT_ATTRIBUTE}
        multiple
        className="hidden"
        onChange={e => { upload.selectFiles(fromFileList(e.target.files ?? [])); e.target.value = '' }}
      />

      {/* ── Review + upload ───────────────────────────────────────────────── */}
      {(phase === 'preview' || phase === 'uploading' || phase === 'done') && (
        <>
          <Card>
            <CardContent className="space-y-4 p-5">

              {/* Header row */}
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1">
                  <p className="font-semibold">
                    {phase === 'done'
                      ? counts.uploaded > 0 ? 'Upload complete' : 'Upload finished with errors'
                      : phase === 'uploading' ? 'Uploading images…'
                      : `${counts.selectable} image${counts.selectable === 1 ? '' : 's'} ready to upload`}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {summary.folderName
                      ? <>From <span className="font-medium text-foreground">{summary.folderName}</span></>
                      : 'Selected images'}
                    {session && <> · catalog <span className="font-medium text-foreground">{session.storeName}</span></>}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {phase === 'preview' && (
                    <>
                      <Button variant="ghost" size="lg" onClick={upload.reset}>
                        Clear
                      </Button>
                      <Button size="lg" onClick={upload.startUpload} disabled={counts.selectable === 0}>
                        <Upload className="h-4 w-4" />
                        Upload {counts.selectable} image{counts.selectable === 1 ? '' : 's'}
                      </Button>
                    </>
                  )}
                  {phase === 'uploading' && (
                    <Button variant="outline" size="lg" onClick={upload.cancel}>
                      <X className="h-4 w-4" />
                      Cancel
                    </Button>
                  )}
                  {phase === 'done' && (counts.failed > 0 || counts.cancelled > 0) && (
                    <Button size="lg" onClick={upload.retryFailed}>
                      <RotateCcw className="h-4 w-4" />
                      Retry {counts.failed + counts.cancelled}
                    </Button>
                  )}
                  {phase === 'done' && (
                    <Button variant="outline" size="lg" onClick={upload.reset}>
                      <FolderUp className="h-4 w-4" />
                      New upload
                    </Button>
                  )}
                </div>
              </div>

              {/* Skipped-file notice */}
              {(summary.unsupported > 0 || summary.system > 0 || summary.duplicates > 0) && phase === 'preview' && (
                <div className="flex items-start gap-2.5 rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <p>
                    Skipped{' '}
                    {[
                      summary.unsupported > 0 && `${summary.unsupported} unsupported file${summary.unsupported === 1 ? '' : 's'}`,
                      summary.system > 0 && `${summary.system} system/hidden file${summary.system === 1 ? '' : 's'}`,
                      summary.duplicates > 0 && `${summary.duplicates} duplicate${summary.duplicates === 1 ? '' : 's'}`,
                    ].filter(Boolean).join(', ')}
                    . Only JPG, PNG, WEBP and AVIF images are imported — duplicates can be added back individually.
                  </p>
                </div>
              )}

              {/* Progress */}
              {(phase === 'uploading' || phase === 'done') && (
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium tabular-nums">{counts.percent}%</span>
                    <span className="text-muted-foreground tabular-nums">
                      {counts.uploaded} of {counts.selectable} uploaded
                    </span>
                  </div>
                  <Progress value={counts.percent} />
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <Stat label="Uploaded" value={counts.uploaded} tone="green" />
                    <Stat label="Remaining" value={counts.remaining} />
                    {counts.inFlight > 0 && <Stat label="In progress" value={counts.inFlight} />}
                    {counts.failed > 0 && <Stat label="Failed" value={counts.failed} tone="red" />}
                    {counts.cancelled > 0 && <Stat label="Cancelled" value={counts.cancelled} />}
                  </div>
                </div>
              )}

              {fatalError && (
                <div className="flex items-start gap-2.5 rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm">
                  <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                  <p className="font-medium text-destructive">{fatalError}</p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* ── Success next-steps ─────────────────────────────────────────── */}
          {phase === 'done' && counts.uploaded > 0 && session && (
            <Card>
              <CardContent className="space-y-4 p-5">
                <div className="flex items-start gap-3">
                  <CheckCircle2 className="mt-0.5 h-6 w-6 shrink-0 text-green-500" />
                  <div>
                    <p className="font-semibold">
                      {counts.uploaded} product{counts.uploaded === 1 ? '' : 's'} created
                    </p>
                    <p className="text-sm text-muted-foreground">
                      They behave like any other product — templates, rules and generation all apply.
                    </p>
                  </div>
                </div>

                <div className="grid gap-2 sm:grid-cols-2">
                  <Button variant="outline" asChild>
                    <Link href="/dashboard/products">
                      <ImageIcon className="h-4 w-4" />
                      View products
                    </Link>
                  </Button>
                  <Button asChild>
                    <Link href="/dashboard/creatives">
                      <Wand2 className="h-4 w-4" />
                      Generate creatives
                    </Link>
                  </Button>
                </div>

                <a
                  href={`/api/catalog/export?importId=${session.importId}&format=xlsx`}
                  target="_blank"
                  rel="noreferrer"
                  className="flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-medium transition-colors hover:bg-muted"
                >
                  <Download className="h-4 w-4 text-green-600" />
                  Download Excel with results
                  <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                </a>

                <div className="flex items-center gap-3 rounded-lg bg-primary/5 px-3 py-2.5 text-sm">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/20 text-xs font-bold text-primary">!</span>
                  <span className="flex-1 text-muted-foreground">
                    Create a template first if you haven&apos;t — then Rules Engine → apply to this catalog
                  </span>
                  <Link
                    href="/dashboard/templates"
                    className="flex shrink-0 items-center gap-0.5 text-xs font-medium text-primary hover:underline"
                  >
                    Templates <ArrowRight className="h-3 w-3" />
                  </Link>
                </div>
              </CardContent>
            </Card>
          )}

          {/* ── Preview grid ───────────────────────────────────────────────── */}
          <ImagePreviewGrid
            items={items}
            busy={busy}
            onRemove={upload.removeItem}
            onInclude={upload.includeItem}
            onDimensions={upload.setDimensions}
          />
        </>
      )}
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'green' | 'red' }) {
  return (
    <span className="flex items-center gap-1">
      <span className={cn(
        'font-semibold tabular-nums',
        tone === 'green' && 'text-green-600',
        tone === 'red' && 'text-destructive',
        !tone && 'text-foreground'
      )}>
        {value}
      </span>
      {label}
    </span>
  )
}
