'use client'

import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Loader2, Upload, X, ImageIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface UploadedImage {
  url: string
  cloudinaryId?: string | null
}

interface ReferenceUploadProps {
  value: UploadedImage | null
  onChange: (value: UploadedImage | null) => void
}

async function uploadFile(file: File, kind: string): Promise<UploadedImage> {
  const form = new FormData()
  form.append('file', file)
  form.append('kind', kind)
  const res = await fetch('/api/upload', { method: 'POST', body: form })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'Upload failed')
  return { url: data.url as string }
}

// Single-image dropzone for the reference advertisement — defines the
// background, layout, typography, branding, and composition that must be
// preserved for every adapted output.
export function ReferenceUpload({ value, onChange }: ReferenceUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)

  async function handleFile(file: File | undefined) {
    if (!file) return
    setError(null)
    setUploading(true)
    try {
      const uploaded = await uploadFile(file, 'adaptation-reference')
      onChange(uploaded)
    } catch (err: any) {
      setError(err.message || 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  if (value) {
    return (
      <div className="relative overflow-hidden rounded-lg border">
        <img src={value.url} alt="Reference advertisement" className="aspect-[3/4] w-full object-cover" />
        <Button
          type="button"
          size="icon-sm"
          variant="secondary"
          className="absolute top-2 right-2"
          onClick={() => onChange(null)}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    )
  }

  return (
    <div>
      <div
        onClick={() => inputRef.current?.click()}
        onDragOver={e => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => {
          e.preventDefault()
          setDragOver(false)
          handleFile(e.dataTransfer.files?.[0])
        }}
        className={cn(
          'flex aspect-[3/4] w-full cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed text-muted-foreground transition-colors',
          dragOver ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'
        )}
      >
        {uploading ? (
          <Loader2 className="h-6 w-6 animate-spin" />
        ) : (
          <>
            <Upload className="h-6 w-6 opacity-50" />
            <p className="text-sm font-medium">Upload reference advertisement</p>
            <p className="text-xs">PNG, JPEG, or WEBP</p>
          </>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={e => handleFile(e.target.files?.[0])}
      />
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      {!value && !uploading && (
        <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
          <ImageIcon className="h-3 w-3" /> An ad you found on Pinterest, Instagram, or a competitor site
        </p>
      )}
    </div>
  )
}
