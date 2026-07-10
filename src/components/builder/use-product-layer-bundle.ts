'use client'

/**
 * useProductLayerBundle — Live Editor Hook
 *
 * FILE: src/components/builder/use-product-layer-bundle.ts  (NEW FILE)
 *
 * Unified replacement for the three separate hooks previously used by
 * canvas-preview.tsx:
 *   - useTransparentPreview        (transparent cutout)
 *   - useProductBounds             (bounding box for Head Space)
 *   - useBackgroundReconstructionPreview  (original background plate)
 *
 * One API call per image instead of three. Returns all assets the canvas
 * preview needs in one state object.
 *
 * Session cache (module-level) survives component remounts within the same
 * page session — same pattern as the existing hooks it replaces.
 */

import { useState, useEffect, useRef } from 'react'
import type { ProductLayerMetadata } from '@/types/product-layer'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ProductLayerBundleState {
  /** Transparent cutout PNG (same as old useTransparentPreview.transparentUrl) */
  transparentUrl: string | null

  /**
   * Background plate (original backdrop with product region inpainted).
   * null when the plate generation failed — canvas falls back to blur-extend.
   * (Same as old useBackgroundReconstructionPreview.backgroundUrl)
   */
  backgroundUrl: string | null

  /**
   * Stored product geometry — head_y, feet_y, bbox, shot_type, safe_max_upscale.
   * Used by canvas-preview.tsx for instant local Head Space placement.
   * (Same as old useProductBounds.bounds but richer + no extra API call)
   */
  metadata: ProductLayerMetadata | null

  loading: boolean
  error: string | null

  /**
   * 'idle'     = hook not yet active (disabled=true or no imageUrl)
   * 'loading'  = API call in-flight
   * 'complete' = transparentUrl + backgroundUrl + metadata all present
   * 'partial'  = transparentUrl + metadata present, backgroundUrl = null
   * 'error'    = API call failed
   */
  bundleStatus: 'idle' | 'loading' | 'complete' | 'partial' | 'error'

  /** Force-reload, bypassing session cache */
  retry: () => void
}

// ─── Session cache ────────────────────────────────────────────────────────────

interface CachedBundle {
  transparentUrl: string
  backgroundUrl: string | null
  metadata: ProductLayerMetadata
  bundleStatus: 'complete' | 'partial'
}

const sessionCache = new Map<string, CachedBundle>()

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * @param imageUrl   The original product image URL (Shopify CDN or Drive).
 * @param storeId    The store the product belongs to (for auth + cache scope).
 * @param enabled    Set false to disable the hook entirely (e.g. when not in
 *                   AI Product Mode). Avoids unnecessary API calls.
 */
export function useProductLayerBundle(
  imageUrl: string | null,
  storeId: string | null,
  enabled: boolean
): ProductLayerBundleState {
  const [state, setState] = useState<ProductLayerBundleState>({
    transparentUrl: null,
    backgroundUrl:  null,
    metadata:       null,
    loading:        false,
    error:          null,
    bundleStatus:   'idle',
    retry: () => {},  // placeholder — replaced in useEffect below
  })

  const requestIdRef = useRef(0)

  // Expose retry as a stable callback on the state object
  const retryRef = useRef<() => void>(() => {})

  function startLoad(bustCache = false) {
    if (!enabled || !imageUrl || !storeId) {
      setState(s => ({
        ...s,
        transparentUrl: null,
        backgroundUrl:  null,
        metadata:       null,
        loading:        false,
        error:          null,
        bundleStatus:   'idle',
      }))
      return
    }

    const cacheKey = `${storeId}:${imageUrl}`

    if (!bustCache) {
      const cached = sessionCache.get(cacheKey)
      if (cached) {
        setState(s => ({
          ...s,
          transparentUrl: cached.transparentUrl,
          backgroundUrl:  cached.backgroundUrl,
          metadata:       cached.metadata,
          loading:        false,
          error:          null,
          bundleStatus:   cached.bundleStatus,
        }))
        return
      }
    }

    const requestId = ++requestIdRef.current
    setState(s => ({
      ...s,
      loading:      true,
      error:        null,
      bundleStatus: 'loading',
    }))

    async function run() {
      try {
        const res = await fetch('/api/product-layer/bundle', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ imageUrl, storeId }),
        })

        if (requestIdRef.current !== requestId) return  // stale request

        const data = await res.json()

        if (!res.ok) {
          throw new Error(data.error || `HTTP ${res.status}`)
        }

        const bundle: CachedBundle = {
          transparentUrl: data.transparentUrl,
          backgroundUrl:  data.backgroundUrl ?? null,
          metadata:       data.metadata,
          bundleStatus:   data.bundleStatus === 'complete' ? 'complete' : 'partial',
        }

        sessionCache.set(cacheKey, bundle)

        setState(s => ({
          ...s,
          transparentUrl: bundle.transparentUrl,
          backgroundUrl:  bundle.backgroundUrl,
          metadata:       bundle.metadata,
          loading:        false,
          error:          null,
          bundleStatus:   bundle.bundleStatus,
        }))
      } catch (err: any) {
        if (requestIdRef.current !== requestId) return
        setState(s => ({
          ...s,
          loading:      false,
          error:        err.message || 'Bundle request failed',
          bundleStatus: 'error',
        }))
      }
    }

    run()
  }

  useEffect(() => {
    retryRef.current = () => {
      if (imageUrl && storeId) {
        sessionCache.delete(`${storeId}:${imageUrl}`)
      }
      startLoad(true)
    }
    // Update state so consumers get the fresh retry fn
    setState(s => ({ ...s, retry: retryRef.current }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageUrl, storeId, enabled])

  useEffect(() => {
    startLoad(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageUrl, storeId, enabled])

  return { ...state, retry: retryRef.current }
}