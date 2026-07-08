'use client'

import { useEffect, useRef, useState } from 'react'
import type { ProductPositioningSettings, ShotType } from '@/types/template'

export interface PositioningPreviewResult {
  apply: boolean
  shotType: ShotType | null
  placement: { imgX: number; imgY: number; renderedW: number; renderedH: number; scale: number } | null
  wouldCrop: boolean
}

// Module-level in-memory cache, same convention as use-transparent-preview.ts /
// use-extend-preview.ts. Unlike those hooks, the cache key includes the full
// settings JSON — every slider drag changes the result, so it's far less
// effective during active editing, which is why the effect below is debounced.
const sessionCache = new Map<string, PositioningPreviewResult>()

const DEBOUNCE_MS = 200

interface UseProductPositioningPreviewResult {
  result: PositioningPreviewResult | null
  loading: boolean
  error: string | null
}

export function useProductPositioningPreview(
  imageUrl: string | null,
  canvasWidth: number,
  canvasHeight: number,
  settings: ProductPositioningSettings | undefined,
  manualShotTypeOverride: ShotType | null | undefined,
  storeId: string | null,
  enabled: boolean
): UseProductPositioningPreviewResult {
  const [result, setResult] = useState<PositioningPreviewResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestIdRef = useRef(0)

  useEffect(() => {
    if (!enabled || !settings?.enabled || !imageUrl || !storeId || !canvasWidth || !canvasHeight) {
      setResult(null)
      setError(null)
      return
    }

    const cacheKey = `${storeId}:${imageUrl}:${canvasWidth}x${canvasHeight}:${JSON.stringify(settings)}:${manualShotTypeOverride ?? ''}`
    const cached = sessionCache.get(cacheKey)
    if (cached) {
      setResult(cached)
      setError(null)
      return
    }

    const requestId = ++requestIdRef.current
    const timer = setTimeout(async () => {
      setLoading(true)
      setError(null)
      try {
        const res = await fetch('/api/product-positioning/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            imageUrl, canvasWidth, canvasHeight, settings,
            manualShotTypeOverride: manualShotTypeOverride ?? null,
            storeId,
          }),
        })
        const data = await res.json()
        if (requestIdRef.current !== requestId) return

        if (!res.ok) {
          setError(data.error || 'Positioning preview failed')
          return
        }

        sessionCache.set(cacheKey, data)
        setResult(data)
      } catch (err: any) {
        if (requestIdRef.current === requestId) setError(err.message || 'Positioning preview failed')
      } finally {
        if (requestIdRef.current === requestId) setLoading(false)
      }
    }, DEBOUNCE_MS)

    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageUrl, canvasWidth, canvasHeight, JSON.stringify(settings), manualShotTypeOverride, storeId, enabled])

  return { result, loading, error }
}
