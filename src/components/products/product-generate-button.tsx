'use client'

import { useState } from 'react'
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
}: {
  productId: string
  storeId: string
  variantId?: string | null
}) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const router = useRouter()

  async function handleGenerate() {
    setLoading(true)
    setError('')

    const res = await fetch('/api/generate/single', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId, storeId, variantId: variantId ?? null }),
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