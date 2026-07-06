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
      // 1. Get all products for this store, then find their generated images.
      //    generated_images has no store_id column — it links to store via product_id.
      const { createClient } = await import('@/lib/supabase/client')
      const supabase = createClient()

      // Step A: load product IDs + names for this store
      const { data: storeProducts, error: prodErr } = await supabase
        .from('products')
        .select('id, title, sku')
        .eq('store_id', storeId)

      if (prodErr) throw new Error(prodErr.message)
      if (!storeProducts?.length) throw new Error('No products found for this store.')

      const productIdToName = new Map(
        storeProducts.map(p => [p.id, p.sku || p.title || p.id])
      )
      const productIds = storeProducts.map(p => p.id)

      // Step B: get generated images for those products
      const { data: creatives, error: dbErr } = await supabase
        .from('generated_images')
        .select('id, generated_url, product_id')
        .in('product_id', productIds)
        .eq('status', 'completed')
        .not('generated_url', 'is', null)
        .order('updated_at', { ascending: false })

      if (dbErr) throw new Error(dbErr.message)
      if (!creatives?.length) throw new Error('No generated images found. Generate some creatives first.')

      setTotal(creatives.length)
      setZipState('downloading')

      // 2. Load JSZip dynamically
      const JSZip = (await import('jszip')).default
      const zip = new JSZip()

      // 3. Download each image and add to ZIP
      for (let i = 0; i < creatives.length; i++) {
        const creative = creatives[i]
        const url = creative.generated_url
        if (!url) continue

        try {
          // Fetch the Cloudinary image
          const response = await fetch(url)
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const blob = await response.blob()

          // Build a clean filename from the product SKU/title
          const productName = productIdToName.get(creative.product_id) ?? `creative-${i + 1}`
          const safeName = productName.replace(/[^a-zA-Z0-9\-_ .]/g, '_').slice(0, 60)
          const ext = blob.type.includes('png') ? 'png' : 'jpg'
          const filename = `${safeName}.${ext}`

          zip.file(filename, blob)
          setProgress(i + 1)
        } catch {
          // Skip failed images — don't abort the whole ZIP
        }
      }

      setZipState('zipping')

      // 4. Generate the ZIP blob
      const zipBlob = await zip.generateAsync(
        { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 3 } },
        (metadata) => {
          // Optional: could show zip compression progress here
        }
      )

      // 5. Trigger browser download
      const zipUrl = URL.createObjectURL(zipBlob)
      const anchor = document.createElement('a')
      anchor.href = zipUrl
      anchor.download = `creatives-${new Date().toISOString().slice(0, 10)}.zip`
      document.body.appendChild(anchor)
      anchor.click()
      document.body.removeChild(anchor)
      URL.revokeObjectURL(zipUrl)

      setZipState('done')
      // Reset after 3 seconds
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

      {/* Error */}
      {error && (
        <p className="text-xs text-destructive max-w-xs">{error}</p>
      )}

      {/* Progress bar */}
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