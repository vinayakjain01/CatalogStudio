'use client'

import { useState, useEffect, useRef } from 'react'
import type { ProductBounds } from '@/lib/product-positioning-shared'

/**
 * Fetches (and session-caches) the product's pixel bounding box — ONCE per
 * image. All downstream math (classification, placement) then runs
 * client-side in product-positioning-shared.ts on every slider change with
 * zero further API calls, making the live preview instantaneous. This
 * replaces the earlier design where every Head Space slider drag made a
 * debounced server round-trip for the full placement result.
 *
 * Bounds only change when the image changes — never when settings change —
 * which is what makes this split correct: one network fetch per image,
 * pure local math per keystroke.
 */

const sessionCache = new Map<string, ProductBounds>()

interface UseProductBoundsResult {
  bounds: ProductBounds | null
  loading: boolean
  error: string | null
}

export function useProductBounds(
  imageUrl: string | null,
  storeId: string | null,
  enabled: boolean,
  mode: 'alpha' | 'zoom' = 'alpha'
): UseProductBoundsResult {
  const [bounds, setBounds] = useState<ProductBounds | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestIdRef = useRef(0)

  useEffect(() => {
    if (!enabled || !imageUrl || !storeId) {
      setBounds(null)
      setError(null)
      return
    }

    const cacheKey = `${storeId}:${imageUrl}:${mode}`
    const cached = sessionCache.get(cacheKey)
    if (cached) {
      setBounds(cached)
      setError(null)
      return
    }

    const requestId = ++requestIdRef.current
    setLoading(true)
    setError(null)

    async function run() {
      try {
        const modeParam = mode === 'zoom' ? '&mode=zoom' : ''
        const res = await fetch(
          `/api/product-positioning/bounds?imageUrl=${encodeURIComponent(imageUrl!)}&storeId=${storeId}${modeParam}`
        )
        const data = await res.json()
        if (requestIdRef.current !== requestId) return

        if (!res.ok || !data.bounds) {
          setError(data.error || 'Bounds detection failed')
          return
        }

        sessionCache.set(cacheKey, data.bounds)
        setBounds(data.bounds)
      } catch (err: any) {
        if (requestIdRef.current === requestId) setError(err.message || 'Bounds detection failed')
      } finally {
        if (requestIdRef.current === requestId) setLoading(false)
      }
    }

    run()
  }, [imageUrl, storeId, enabled, mode])

  return { bounds, loading, error }
}
