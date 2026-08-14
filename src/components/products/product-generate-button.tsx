'use client'

import { useState } from 'react'
import { shopifyFetch } from '@/lib/shopify-token'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Wand2, Loader2 } from 'lucide-react'

/**
 * variantId is optional so the Products list can still generate at product
 * level, but the detail page passes the SELECTED variant — otherwise the
 * variant picker is cosmetic and every variant renders variant[0]'s price,
 * stock and options.
 */
export function ProductGenerateButton({
  productId,
  storeId,
  variantId,
  imageId,
}: {
  productId: string
  storeId: string
  variantId?: string | null
  /** Which source photo to composite. Omitted, the primary image is used. */
  imageId?: string | null
}) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const router = useRouter()

  async function handleGenerate() {
    setLoading(true)
    setError('')

    // shopifyFetch attaches the App Bridge session token when running inside
    // the Shopify admin, and falls back to plain fetch outside it.
    const res = await shopifyFetch('/api/generate/single', {
      method: 'POST',
      body: JSON.stringify({ productId, storeId, variantId: variantId ?? null, imageId: imageId ?? null }),
    })

    const data = await res.json()

    if (res.ok) {
      if (data.generated === 0) {
        // No rule matched — tell the user instead of silently doing nothing.
        setError(data.message || 'No rule matches this product.')
      } else {
        router.refresh()
      }
    } else {
      setError(data.error || 'Generation failed')
    }
    setLoading(false)
  }

  return (
    <div className="flex items-center gap-2">
      {error && <span className="text-xs text-destructive">{error}</span>}
      <Button size="sm" variant="outline" onClick={handleGenerate} disabled={loading}>
        {loading ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5 mr-1.5" />}
        {loading ? 'Generating…' : 'Generate'}
      </Button>
    </div>
  )
}