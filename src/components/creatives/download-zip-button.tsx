'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Download, Loader2, CheckCircle2 } from 'lucide-react'

interface DownloadZipButtonProps {
  storeId: string
}

type ZipState = 'idle' | 'fetching' | 'downloading' | 'zipping' | 'done'

export function DownloadZipButton({ storeId }: DownloadZipButtonProps) {
  const [zipState, setZipState] = useState<ZipState>('idle')
  const [progress, setProgress] = useState(0)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)

  async function handleDownload() {
    setZipState('fetching')
    setError(null)
    setProgress(0)

    try {
      const { createClient } = await import('@/lib/supabase/client')
      const supabase = createClient()

      // generated_creatives carries store_id directly — no join through
      // products needed, and (unlike the legacy generated_images table) one
      // row per variant/image survives rather than only the last written.
      const { data: creatives, error: dbErr } = await supabase
        .from('generated_creatives')
        .select(`
          id, url,
          products(title, sku),
          product_variants(title, sku, option1, option2, option3)
        `)
        .eq('store_id', storeId)
        .not('url', 'is', null)
        .order('created_at', { ascending: false })

      if (dbErr) throw new Error(dbErr.message)
      if (!creatives?.length) throw new Error('No generated creatives found. Generate some first.')

      setTotal(creatives.length)
      setZipState('downloading')

      const JSZip = (await import('jszip')).default
      const zip = new JSZip()
      const usedNames = new Set<string>()

      for (let i = 0; i < creatives.length; i++) {
        const creative = creatives[i] as any
        const url: string | null = creative.url
        if (!url) continue

        try {
          const response = await fetch(url)
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const blob = await response.blob()

          const filename = buildFilename(creative, i, blob.type, usedNames)
          zip.file(filename, blob)
          setProgress(i + 1)
        } catch {
          // Skip failed images — don't abort the whole ZIP
        }
      }

      setZipState('zipping')

      const zipBlob = await zip.generateAsync(
        { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 3 } }
      )

      const zipUrl = URL.createObjectURL(zipBlob)
      const anchor = document.createElement('a')
      anchor.href = zipUrl
      anchor.download = `creatives-${new Date().toISOString().slice(0, 10)}.zip`
      document.body.appendChild(anchor)
      anchor.click()
      document.body.removeChild(anchor)
      URL.revokeObjectURL(zipUrl)

      setZipState('done')
      setTimeout(() => setZipState('idle'), 3000)
    } catch (err: any) {
      setError(err.message)
      setZipState('idle')
    }
  }

  const isLoading = zipState !== 'idle' && zipState !== 'done'

  const label = {
    idle: 'Download All (ZIP)',
    fetching: 'Fetching images…',
    downloading: `Downloading ${progress}/${total}…`,
    zipping: 'Creating ZIP…',
    done: 'Downloaded!',
  }[zipState]

  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        variant="outline"
        size="sm"
        onClick={handleDownload}
        disabled={isLoading}
        className={zipState === 'done' ? 'border-green-500 text-green-600' : ''}
      >
        {isLoading ? (
          <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
        ) : zipState === 'done' ? (
          <CheckCircle2 className="h-3.5 w-3.5 mr-1.5 text-green-500" />
        ) : (
          <Download className="h-3.5 w-3.5 mr-1.5" />
        )}
        {label}
      </Button>

      {error && (
        <p className="text-xs text-destructive max-w-xs">{error}</p>
      )}

      {isLoading && zipState === 'downloading' && total > 0 && (
        <div className="w-32 h-1 rounded-full bg-muted overflow-hidden">
          <div
            className="h-full bg-primary transition-all duration-300"
            style={{ width: `${(progress / total) * 100}%` }}
          />
        </div>
      )}
    </div>
  )
}

/**
 * A product with several variant/image creatives now produces several rows,
 * so the old "one file per product" naming would collide. Prefers the
 * variant's own SKU/option label, then the product's, and de-dupes with a
 * numeric suffix as a last resort — no creative is ever silently dropped from
 * the ZIP for sharing a name with another.
 */
function buildFilename(
  creative: { products?: { title?: string; sku?: string } | null; product_variants?: any },
  index: number,
  mimeType: string,
  usedNames: Set<string>
): string {
  const variant = creative.product_variants
  const product = creative.products

  const variantLabel = variant
    ? variant.sku || [variant.option1, variant.option2, variant.option3].filter(Boolean).join('-') || null
    : null

  const base = [product?.sku || product?.title, variantLabel].filter(Boolean).join('-')
    || `creative-${index + 1}`

  const safeBase = base.replace(/[^a-zA-Z0-9\-_ .]/g, '_').slice(0, 60)
  const ext = mimeType.includes('png') ? 'png' : 'jpg'

  let filename = `${safeBase}.${ext}`
  let n = 2
  while (usedNames.has(filename)) {
    filename = `${safeBase}-${n}.${ext}`
    n++
  }
  usedNames.add(filename)
  return filename
}
