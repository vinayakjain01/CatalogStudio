'use client'

import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Loader2, Upload, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { UploadedImage } from './reference-upload'

interface ProductImagesUploadProps {
  value: UploadedImage[]
  onChange: (value: UploadedImage[]) => void
  max?: number
}

async function uploadFile(file: File): Promise<UploadedImage> {
  const form = new FormData()
  form.append('file', file)
  form.append('kind', 'adaptation-product')
  const res = await fetch('/api/upload', { method: 'POST', body: form })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'Upload failed')
  return { url: data.url as string }
}

// Multi-file dropzone (1-10) for the merchant's own product/model photos —
// each one becomes an independent adapted advertisement using the same
// reference template.
export function ProductImagesUpload({ value, onChange, max = 10 }: ProductImagesUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [uploadingCount, setUploadingCount] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)

  async function handleFiles(files: FileList | File[] | null) {
    if (!files) return
    const list = Array.from(files)
    if (list.length === 0) return

    setError(null)
    const remaining = max - value.length
    if (remaining <= 0) {
      setError(`Maximum ${max} product images per job`)
      return
    }
    const toUpload = list.slice(0, remaining)
    if (list.length > remaining) {
      setError(`Only ${remaining} more image(s) can be added (max ${max})`)
    }

    setUploadingCount(c => c + toUpload.length)
    const results = await Promise.allSettled(toUpload.map(uploadFile))
    setUploadingCount(c => c - toUpload.length)

    const uploaded: UploadedImage[] = []
    let failedCount = 0
    for (const r of results) {
      if (r.status === 'fulfilled') uploaded.push(r.value)
      else failedCount++
    }
    if (failedCount > 0) setError(`${failedCount} image(s) failed to upload`)
    if (uploaded.length > 0) onChange([...value, ...uploaded])
  }

  function removeAt(index: number) {
    onChange(value.filter((_, i) => i !== index))
  }

  const canAddMore = value.length < max

  return (
    <div>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
        {value.map((img, i) => (
          <div key={i} className="group relative aspect-square overflow-hidden rounded-lg border">
            <img src={img.url} alt={`Product ${i + 1}`} className="h-full w-full object-cover" />
            <Button
              type="button"
              size="icon-sm"
              variant="secondary"
              className="absolute top-1 right-1 opacity-0 transition-opacity group-hover:opacity-100"
              onClick={() => removeAt(i)}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}

        {canAddMore && (
          <div
            onClick={() => inputRef.current?.click()}
            onDragOver={e => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={e => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files) }}
            className={cn(
              'flex aspect-square cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed text-muted-foreground transition-colors',
              dragOver ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'
            )}
          >
            {uploadingCount > 0 ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
              <>
                <Upload className="h-5 w-5 opacity-50" />
                <span className="text-xs">Add photos</span>
              </>
            )}
          </div>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        className="hidden"
        onChange={e => { handleFiles(e.target.files); e.target.value = '' }}
      />

      <p className="mt-2 text-xs text-muted-foreground">
        {value.length}/{max} product photos — each generates one adapted advertisement
      </p>
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  )
}
