'use client'

import { useState, useEffect, useRef } from 'react'

/**
 * In-memory cache (module-level, survives component remounts within the
 * same page session) — same convention as use-transparent-preview.ts.
 */
const sessionCache = new Map<string, string>()

interface UseBackgroundReconstructionPreviewResult {
  backgroundUrl: string | null
  loading: boolean
  error: string | null
  retry: () => void
}

/**
 * Fetches (and caches) the reconstructed-original-background preview for the
 * template builder's "Original Background" mode. Only runs once per unique
 * image per session (like use-transparent-preview.ts) — NOT on every
 * settings tweak, since there are no tunable settings here, just an image.
 *
 * Requires the transparent cutout URL (from useTransparentPreview) since
 * that's how the reconstruction step knows exactly where the product is.
 */
export function useBackgroundReconstructionPreview(
  imageUrl: string | null,
  transparentUrl: string | null,
  storeId: string | null,
  enabled: boolean
): UseBackgroundReconstructionPreviewResult {
  const [backgroundUrl, setBackgroundUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestIdRef = useRef(0)

  function load() {
    if (!enabled || !imageUrl || !transparentUrl || !storeId) {
      setBackgroundUrl(null)
      setError(null)
      return
    }

    const cacheKey = `${storeId}:${imageUrl}`
    const cached = sessionCache.get(cacheKey)
    if (cached) {
      setBackgroundUrl(cached)
      setError(null)
      return
    }

    const requestId = ++requestIdRef.current
    setLoading(true)
    setError(null)

    async function run() {
      try {
        // Step 1: check server-side cache (cheap, no AI call)
        const checkRes = await fetch(
          `/api/background-reconstruction?imageUrl=${encodeURIComponent(imageUrl!)}&storeId=${storeId}`
        )
        const checkData = await checkRes.json()

        if (requestIdRef.current !== requestId) return

        if (checkData.cached && checkData.backgroundUrl) {
          sessionCache.set(cacheKey, checkData.backgroundUrl)
          setBackgroundUrl(checkData.backgroundUrl)
          setLoading(false)
          return
        }

        // Step 2: not cached — trigger actual Generative Remove
        const reconRes = await fetch('/api/background-reconstruction', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ imageUrl, transparentUrl, storeId }),
        })
        const reconData = await reconRes.json()

        if (requestIdRef.current !== requestId) return

        if (!reconRes.ok || !reconData.backgroundUrl) {
          setError(reconData.error || 'Background reconstruction unavailable')
          setLoading(false)
          return
        }

        sessionCache.set(cacheKey, reconData.backgroundUrl)
        setBackgroundUrl(reconData.backgroundUrl)
      } catch (err: any) {
        if (requestIdRef.current === requestId) {
          setError(err.message || 'Background reconstruction failed')
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
  }, [imageUrl, transparentUrl, storeId, enabled])

  function retry() {
    if (imageUrl && storeId) sessionCache.delete(`${storeId}:${imageUrl}`)
    load()
  }

  return { backgroundUrl, loading, error, retry }
}
