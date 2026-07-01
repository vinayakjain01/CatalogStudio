'use client'

import { useState, useEffect, useRef } from 'react'

// Module-level in-memory cache: survives component remounts within the session.
// Avoids re-calling the API when switching preview products back and forth.
const sessionCache = new Map<string, string>()

interface UseExtendPreviewResult {
  extendedUrl: string | null
  loading: boolean
  error: string | null
  retry: () => void
}

/**
 * Fetches (and caches) an AI-extended image preview for the template builder.
 * Used by the canvas preview when an image layer has objectFit='ai_extend'.
 *
 * Flow:
 *  1. GET /api/image-extend to check server cache (cheap, no AI call)
 *  2. If not cached: POST /api/image-extend to trigger Cloudinary generative fill
 *  3. Result stored in both session cache and server cache
 */
export function useExtendPreview(
  imageUrl: string | null,
  targetWidth: number,
  targetHeight: number,
  storeId: string | null,
  enabled: boolean
): UseExtendPreviewResult {
  const [extendedUrl, setExtendedUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestIdRef = useRef(0)

  function load() {
    if (!enabled || !imageUrl || !storeId || !targetWidth || !targetHeight) {
      setExtendedUrl(null)
      setError(null)
      return
    }

    const cacheKey = `${storeId}:${imageUrl}:${targetWidth}x${targetHeight}`
    const cached = sessionCache.get(cacheKey)
    if (cached) {
      setExtendedUrl(cached)
      setError(null)
      return
    }

    const requestId = ++requestIdRef.current
    setLoading(true)
    setError(null)

    async function run() {
      try {
        // Check server cache first (cheap)
        const checkRes = await fetch(
          `/api/image-extend?imageUrl=${encodeURIComponent(imageUrl!)}&targetWidth=${targetWidth}&targetHeight=${targetHeight}&storeId=${storeId}`
        )
        const checkData = await checkRes.json()

        if (requestIdRef.current !== requestId) return

        if (checkData.cached && checkData.extendedUrl) {
          sessionCache.set(cacheKey, checkData.extendedUrl)
          setExtendedUrl(checkData.extendedUrl)
          setLoading(false)
          return
        }

        // Trigger actual generation
        const extendRes = await fetch('/api/image-extend', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ imageUrl, targetWidth, targetHeight, storeId }),
        })
        const extendData = await extendRes.json()

        if (requestIdRef.current !== requestId) return

        if (!extendRes.ok) {
          setError(extendData.error || 'AI extend failed')
          setLoading(false)
          return
        }

        sessionCache.set(cacheKey, extendData.extendedUrl)
        setExtendedUrl(extendData.extendedUrl)
      } catch (err: any) {
        if (requestIdRef.current === requestId) {
          setError(err.message || 'AI extend failed')
        }
      } finally {
        if (requestIdRef.current === requestId) {
          setLoading(false)
        }
      }
    }

    run()
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageUrl, targetWidth, targetHeight, storeId, enabled])

  function retry() {
    if (imageUrl && storeId) {
      sessionCache.delete(`${storeId}:${imageUrl}:${targetWidth}x${targetHeight}`)
    }
    load()
  }

  return { extendedUrl, loading, error, retry }
}