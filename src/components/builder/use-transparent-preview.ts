'use client'

import { useState, useEffect, useRef } from 'react'

/**
 * In-memory cache (module-level, survives component remounts within the
 * same page session) so switching products back and forth in the builder
 * never re-triggers the API call for an image already resolved this session.
 */
const sessionCache = new Map<string, string>()

interface UseTransparentPreviewResult {
  transparentUrl: string | null
  loading: boolean
  error: string | null
  /** Force a fresh removal, bypassing both the session cache and the server cache. */
  retry: () => void
}

/**
 * Fetches (and caches) a transparent PNG preview for the given product image.
 * Used by the template builder canvas to show a live "what will this look
 * like after background removal" preview when AI Product Mode is enabled.
 *
 * Calls GET /api/background/remove first (cheap, checks server cache only).
 * If not cached, calls POST /api/background/remove to actually run the AI
 * provider — this is the expensive path and only runs once per unique image.
 */
export function useTransparentPreview(
  imageUrl: string | null,
  storeId: string | null,
  enabled: boolean
): UseTransparentPreviewResult {
  const [transparentUrl, setTransparentUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestIdRef = useRef(0)

  function load() {
    if (!enabled || !imageUrl || !storeId) {
      setTransparentUrl(null)
      setError(null)
      return
    }

    const cacheKey = `${storeId}:${imageUrl}`
    const cached = sessionCache.get(cacheKey)
    if (cached) {
      setTransparentUrl(cached)
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
          `/api/background/remove?imageUrl=${encodeURIComponent(imageUrl!)}&storeId=${storeId}`
        )
        const checkData = await checkRes.json()

        if (requestIdRef.current !== requestId) return // stale request, ignore

        if (checkData.cached && checkData.transparentUrl) {
          sessionCache.set(cacheKey, checkData.transparentUrl)
          setTransparentUrl(checkData.transparentUrl)
          setLoading(false)
          return
        }

        // Step 2: not cached server-side — trigger actual removal
        const removeRes = await fetch('/api/background/remove', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ imageUrl, storeId }),
        })
        const removeData = await removeRes.json()

        if (requestIdRef.current !== requestId) return

        if (!removeRes.ok) {
          setError(removeData.error || 'Background removal failed')
          setLoading(false)
          return
        }

        sessionCache.set(cacheKey, removeData.transparentUrl)
        setTransparentUrl(removeData.transparentUrl)
      } catch (err: any) {
        if (requestIdRef.current === requestId) {
          setError(err.message || 'Background removal failed')
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
  }, [imageUrl, storeId, enabled])

  function retry() {
    if (imageUrl && storeId) {
      sessionCache.delete(`${storeId}:${imageUrl}`)
    }
    load()
  }

  return { transparentUrl, loading, error, retry }
}